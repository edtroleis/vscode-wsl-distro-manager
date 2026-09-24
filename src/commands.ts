import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import * as wsl from './wsl';
import { Distro } from './wsl';
import { formatBytes } from './monitor';
import { formatElapsed, withFileProgress, withProgress } from './progress';
import { promptText } from './prompts';
import { clearPending } from './pending';
import { registerTransferCommands } from './transfer';
import { DistroItem, DistroTreeProvider, InfoItem, estimateReclaimable } from './tree';
import { globalUri } from './configFs';

function config() {
	return vscode.workspace.getConfiguration('wslManager');
}

/**
 * The extension runs on the Windows host (extensionKind "ui"), but terminals are
 * created on the remote side when the window is connected to a distro. That is
 * why the terminal path depends on env.remoteName, not on process.platform.
 */
function terminalWslPath(): string {
	const configured = config().get<string>('wslExePath');
	if (configured) {
		return configured;
	}
	return vscode.env.remoteName === 'wsl' ? '/mnt/c/Windows/System32/wsl.exe' : 'wsl.exe';
}

async function pickDistro(
	placeHolder: string,
	filter?: (d: Distro) => boolean,
): Promise<Distro | undefined> {
	const distros = (await wsl.list()).filter(filter ?? (() => true));
	if (distros.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t('No WSL distro available for this action.'));
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(
		distros.map((d) => ({
			label: d.name,
			description: [
				`WSL ${d.version}`,
				d.running ? vscode.l10n.t('Running') : vscode.l10n.t('Stopped'),
				...(d.isDefault ? [vscode.l10n.t('default')] : []),
			].join(' · '),
			distro: d,
		})),
		{ placeHolder },
	);
	return picked?.distro;
}

/** Accepts the item clicked in the view or, when invoked from the palette, shows a QuickPick. */
async function resolveDistro(
	arg: unknown,
	placeHolder: string,
	filter?: (d: Distro) => boolean,
): Promise<Distro | undefined> {
	if (arg instanceof DistroItem) {
		return arg.distro;
	}
	if (arg instanceof InfoItem) {
		return arg.parent.distro;
	}
	if (typeof arg === 'string') {
		const found = (await wsl.list()).find((d) => d.name === arg);
		if (found) {
			return found;
		}
	}
	return pickDistro(placeHolder, filter);
}

async function confirmDestructive(message: string, confirmLabel: string): Promise<boolean> {
	if (!config().get<boolean>('confirmDestructiveActions', true)) {
		return true;
	}
	const choice = await vscode.window.showWarningMessage(
		message,
		{ modal: true },
		confirmLabel,
	);
	return choice === confirmLabel;
}

const windowWarning = () => vscode.l10n.t('This VS Code window is connected to it and will be disconnected.');

/** Reasons an action on this distro deserves a warning no setting can turn off. */
function distroWarnings(distro: string): string[] {
	const warnings: string[] = [];
	if (wsl.isCurrentWindowDistro(distro)) {
		warnings.push(vscode.l10n.t('"{0}" is the distro of this window. {1}', distro, windowWarning()));
	}
	const managed = wsl.managedBy(distro);
	if (managed) {
		warnings.push(
			vscode.l10n.t('"{0}" is managed by {1}; changing it here can break {1}. {2}', distro, managed.tool, managed.hint),
		);
	}
	return warnings;
}

/**
 * Like confirmDestructive, but always asks (even with confirmations turned off)
 * when the action hits the distro this window is connected to, or one managed
 * by another tool, and says why. `detail` is extra context shown in any case.
 */
async function confirmDistroAction(
	distro: string,
	message: string,
	confirmLabel: string,
	detail?: string,
): Promise<boolean> {
	const warnings = distroWarnings(distro);
	if (warnings.length === 0 && !config().get<boolean>('confirmDestructiveActions', true)) {
		return true;
	}
	const choice = await vscode.window.showWarningMessage(
		message,
		{ modal: true, detail: [detail, ...warnings].filter(Boolean).join('\n\n') || undefined },
		confirmLabel,
	);
	return choice === confirmLabel;
}

/** For non-destructive actions: only asks when the distro belongs to another tool. */
async function confirmIfManaged(distro: string, message: string, confirmLabel: string): Promise<boolean> {
	const managed = wsl.managedBy(distro);
	if (!managed) {
		return true;
	}
	const choice = await vscode.window.showWarningMessage(
		message,
		{ modal: true, detail: vscode.l10n.t('"{0}" is managed by {1}. {2}', distro, managed.tool, managed.hint) },
		confirmLabel,
	);
	return choice === confirmLabel;
}

/**
 * Always asks: a shutdown stops every distro, including ones other tools
 * (Docker, Podman) depend on, and those are not restarted for them.
 */
async function confirmShutdown(
	distro: string,
	title: string,
	confirmLabel: string,
	running: string[],
	detailLead?: string,
): Promise<boolean> {
	const managed = running.filter((name) => wsl.managedBy(name));
	const tools = [...new Set(managed.map((name) => wsl.managedBy(name)?.tool))].join(' / ');
	const detail = [
		vscode.l10n.t('WSL keeps the disk of "{0}" attached while any distro is running.', distro) +
			(detailLead ? ` ${detailLead}` : ''),
		running.length === 0
			? ''
			: running.length > managed.length
				? vscode.l10n.t('Running now: {0}. They will be stopped and started again afterwards.', running.join(', '))
				: vscode.l10n.t('Running now: {0}. They will be stopped.', running.join(', ')),
		managed.length > 0
			? vscode.l10n.t('{0} belong to {1} and will not be restarted; start them from that tool.', managed.join(', '), tools)
			: '',
		vscode.l10n.t('Every WSL terminal will be closed.'),
	].filter(Boolean);
	const choice = await vscode.window.showWarningMessage(title, { modal: true, detail: detail.join('\n\n') }, confirmLabel);
	return choice === confirmLabel;
}

/**
 * Stopping a distro unregisters Windows interop in the other running distros
 * (see wsl.restoreInterop). Put it back right after our own stops.
 */
async function healInteropAfterStop(): Promise<void> {
	const running = (await wsl.list()).filter((d) => d.running).map((d) => d.name);
	const restored = await wsl.restoreInterop(running).catch(() => []);
	if (restored.length > 0) {
		vscode.window.setStatusBarMessage(vscode.l10n.t('$(check) Restored Windows interop in {0}', restored.join(', ')), 8000);
	}
}

/** The distro's VHDX, as Windows and as this host see it. */
async function distroDisk(distro: Distro): Promise<{ vhd: string; vhdHost: string; size: number }> {
	const registry = (await wsl.registryInfo()).get(distro.name);
	if (!registry?.basePath || !registry.vhdFileName) {
		throw new Error(vscode.l10n.t('Could not find the virtual disk of "{0}".', distro.name));
	}
	const vhd = path.win32.join(registry.basePath, registry.vhdFileName);
	const vhdHost = await wsl.toHostPath(vhd);
	return { vhd, vhdHost, size: (await fs.stat(vhdHost)).size };
}

/**
 * Checks, before anything changes, whether working on this distro's disk could
 * require shutting WSL down while VS Code windows are connected to it. Current
 * WSL releases a disk only when the whole VM stops, which kills those windows,
 * and they do not reliably reconnect: refuse instead. Returns true if refused.
 */
async function refuseIfShutdownWouldDisconnect(distro: Distro, vhd: string): Promise<boolean> {
	if (distro.running && process.platform !== 'win32' && wsl.isCurrentWindowDistro(distro.name)) {
		vscode.window.showWarningMessage(
			vscode.l10n.t('This extension is running inside "{0}", so it cannot stop it. Run this command from a local VS Code window (not connected to WSL).', distro.name),
		);
		return true;
	}
	const mayNeedShutdown = distro.running || (await wsl.isFileLocked(vhd));
	if (!mayNeedShutdown) {
		return false;
	}
	const connected = await wsl.vscodeConnectedDistros().catch(() => []);
	if (connected.length === 0) {
		return false;
	}
	vscode.window.showWarningMessage(
		vscode.l10n.t('This needs WSL to shut down, which would disconnect the VS Code windows connected to {0}. Nothing was changed.', connected.join(', ')),
		{ modal: true, detail: vscode.l10n.t('Close those windows, then run the command again from a local VS Code window.') },
	);
	return true;
}

/**
 * Stops the distro and waits until Windows releases its VHDX, shutting WSL down
 * (after asking) when stopping alone is not enough. `restart` lists what must be
 * started again afterwards, whatever happens; `released` is false when the user
 * declined the shutdown.
 */
async function releaseDisk(
	distro: Distro,
	vhd: string,
	texts: { progress: string; shutdownTitle: string; shutdownLabel: string; shutdownDetail?: string },
	beforeStop?: () => Promise<void>,
): Promise<{ released: boolean; restart: string[] }> {
	let restart = distro.running ? [distro.name] : [];
	const free = await withProgress(texts.progress, async () => {
		if (distro.running) {
			await beforeStop?.();
			await wsl.terminate(distro.name);
			await healInteropAfterStop();
		}
		return wsl.waitUntilUnlocked(vhd, 5000);
	});
	if (free) {
		return { released: true, restart };
	}
	if (process.platform !== 'win32') {
		throw new Error(
			vscode.l10n.t('The disk of "{0}" stays attached while WSL is running, and shutting WSL down would stop this extension, which runs inside WSL. Run the command from a local VS Code window.', distro.name),
		);
	}
	const distros = await wsl.list();
	const running = distros.filter((d) => d.running).map((d) => d.name);
	if (!(await confirmShutdown(distro.name, texts.shutdownTitle, texts.shutdownLabel, running, texts.shutdownDetail))) {
		return { released: false, restart };
	}
	restart = [...new Set([...restart, ...wsl.distrosToStartAgain(distros)])];
	const released = await withProgress(vscode.l10n.t('Shutting down WSL...'), async () => {
		await wsl.shutdown();
		return wsl.waitUntilUnlocked(vhd, 15000);
	});
	if (!released) {
		throw new Error(vscode.l10n.t('The disk of "{0}" is still in use by another program.', distro.name));
	}
	return { released: true, restart };
}

async function startAgain(names: string[]): Promise<void> {
	if (names.length === 0) {
		return;
	}
	await withProgress(vscode.l10n.t('Starting {0} again...', names.join(', ')), async () => {
		for (const name of names) {
			await wsl.start(name).catch(() => undefined);
		}
	});
}




export function registerCommands(
	context: vscode.ExtensionContext,
	tree: DistroTreeProvider,
): void {
	const register = (id: string, handler: (...args: any[]) => any) => {
		context.subscriptions.push(
			vscode.commands.registerCommand(id, async (...args: any[]) => {
				try {
					await handler(...args);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					vscode.window.showErrorMessage(vscode.l10n.t('WSL: {0}', message));
					tree.refresh();
				}
			}),
		);
	};

	register('wslManager.refresh', () => {
		tree.invalidateDetails();
		tree.refresh();
	});

	register('wslManager.openWindow', async (arg: unknown) => {
		const distro = await resolveDistro(arg, vscode.l10n.t('Open which distro in a new window?'));
		if (!distro) {
			return;
		}
		await vscode.commands.executeCommand('vscode.newWindow', {
			remoteAuthority: `wsl+${distro.name}`,
			reuseWindow: false,
		});
	});

	register('wslManager.openTerminal', async (arg: unknown) => {
		const distro = await resolveDistro(arg, vscode.l10n.t('Open a terminal in which distro?'));
		if (!distro) {
			return;
		}
		const user = config().get<string>('defaultUser', '');
		const args = ['--distribution', distro.name, ...(user ? ['--user', user] : [])];
		const terminal = vscode.window.createTerminal({
			name: distro.name,
			shellPath: terminalWslPath(),
			shellArgs: args,
			iconPath: new vscode.ThemeIcon('terminal-linux'),
		});
		terminal.show();
		tree.refresh();
	});

	register('wslManager.start', async (arg: unknown) => {
		const distro = await resolveDistro(arg, vscode.l10n.t('Start which distro?'), (d) => !d.running);
		if (!distro) {
			return;
		}
		await withProgress(vscode.l10n.t('Starting {0}...', distro.name), () => wsl.start(distro.name));
		tree.refresh();
	});

	register('wslManager.terminate', async (arg: unknown) => {
		const distro = await resolveDistro(arg, vscode.l10n.t('Stop which distro?'), (d) => d.running);
		if (!distro) {
			return;
		}
		const ok = await confirmDistroAction(
			distro.name,
			vscode.l10n.t('Stop "{0}"? Processes running in this distro will be killed.', distro.name),
			vscode.l10n.t('Stop'),
		);
		if (!ok) {
			return;
		}
		await withProgress(vscode.l10n.t('Stopping {0}...', distro.name), async () => {
			await wsl.terminate(distro.name);
			await healInteropAfterStop();
		});
		tree.refresh();
	});

	register('wslManager.restart', async (arg: unknown) => {
		const distro = await resolveDistro(arg, vscode.l10n.t('Restart which distro?'));
		if (!distro) {
			return;
		}
		const ok = await confirmDistroAction(
			distro.name,
			vscode.l10n.t('Restart "{0}"? Running processes will be killed.', distro.name),
			vscode.l10n.t('Restart'),
		);
		if (!ok) {
			return;
		}
		await withProgress(vscode.l10n.t('Restarting {0}...', distro.name), async () => {
			await wsl.terminate(distro.name);
			await wsl.start(distro.name);
		});
		tree.refresh();
	});

	register('wslManager.setDefault', async (arg: unknown) => {
		const distro = await resolveDistro(arg, vscode.l10n.t('Which distro should be the default?'), (d) => !d.isDefault);
		if (!distro) {
			return;
		}
		if (!(await confirmIfManaged(distro.name, vscode.l10n.t('Make "{0}" the default distro?', distro.name), vscode.l10n.t('Set as Default')))) {
			return;
		}
		await wsl.setDefault(distro.name);
		vscode.window.showInformationMessage(vscode.l10n.t('"{0}" is now the default distro.', distro.name));
		tree.refresh();
	});

	register('wslManager.setVersion', async (arg: unknown) => {
		const distro = await resolveDistro(arg, vscode.l10n.t('Convert which distro?'));
		if (!distro) {
			return;
		}
		const target = distro.version === 2 ? 1 : 2;
		const ok = await confirmDistroAction(
			distro.name,
			vscode.l10n.t('Convert "{0}" from WSL {1} to WSL {2}? The conversion copies the entire file system and may take several minutes.', distro.name, distro.version, target),
			vscode.l10n.t('Convert to WSL {0}', target),
		);
		if (!ok) {
			return;
		}
		await withProgress(vscode.l10n.t('Converting {0} to WSL {1}...', distro.name, target), () =>
			wsl.setVersion(distro.name, target as 1 | 2),
		);
		tree.refresh();
	});

	register('wslManager.export', async (arg: unknown) => {
		const distro = await resolveDistro(arg, vscode.l10n.t('Export which distro?'));
		if (!distro) {
			return;
		}
		const home = await wsl.dialogHomeUri();
		const target = await vscode.window.showSaveDialog({
			title: vscode.l10n.t('Export {0}', distro.name),
			defaultUri: vscode.Uri.joinPath(home, `${distro.name}.tar`),
			filters: { [vscode.l10n.t('Tarball')]: ['tar'], [vscode.l10n.t('Virtual disk')]: ['vhdx'] },
		});
		if (!target) {
			return;
		}
		const targetPath = await wsl.toWindowsPath(target);
		const isVhd = targetPath.toLowerCase().endsWith('.vhdx');
		const targetHost = await wsl.toHostPath(targetPath);
		// A .vhdx export copies the disk as is; a .tar holds roughly what the distro uses.
		const disk = await distroDisk(distro).catch(() => undefined);
		const used = !isVhd && distro.running ? (await wsl.runtimeInfo(distro.name).catch(() => undefined))?.diskUsed : undefined;
		const expected = isVhd ? disk?.size : used;
		const exported = await withFileProgress(vscode.l10n.t('Exporting {0}', distro.name), targetHost, expected, (signal) =>
			wsl.exportDistro(distro.name, targetPath, isVhd, signal),
		);
		if (exported === undefined) {
			await fs.rm(targetHost, { force: true });
			vscode.window.showInformationMessage(vscode.l10n.t('Export of "{0}" cancelled; the partial file was removed.', distro.name));
			return;
		}
		vscode.window.showInformationMessage(vscode.l10n.t('"{0}" exported to {1}', distro.name, targetPath));
	});

	register('wslManager.import', async () => {
		const home = await wsl.dialogHomeUri();
		const sources = await vscode.window.showOpenDialog({
			title: vscode.l10n.t('Select the exported file'),
			defaultUri: home,
			canSelectMany: false,
			filters: { [vscode.l10n.t('Exported distro')]: ['tar', 'vhdx'], [vscode.l10n.t('All files')]: ['*'] },
		});
		const source = sources?.[0];
		if (!source) {
			return;
		}
		const sourcePath = await wsl.toWindowsPath(source);

		const existing = new Set((await wsl.list()).map((d) => d.name.toLowerCase()));
		const name = await promptText({
			title: vscode.l10n.t('Name of the new distro'),
			value: path.win32.parse(sourcePath).name,
			validateInput: (value) => {
				const trimmed = value.trim();
				if (!trimmed) {
					return vscode.l10n.t('Enter a name.');
				}
				if (existing.has(trimmed.toLowerCase())) {
					return vscode.l10n.t('A distro with this name already exists.');
				}
				if (/[\\/:*?"<>|]/.test(trimmed)) {
					return vscode.l10n.t('The name cannot contain \\ / : * ? " < > |');
				}
				return undefined;
			},
		});
		if (!name) {
			return;
		}

		const dirs = await vscode.window.showOpenDialog({
			title: vscode.l10n.t('Folder where the distro disk will be created'),
			defaultUri: home,
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
		});
		const installDir = dirs?.[0];
		if (!installDir) {
			return;
		}
		const installPath = await wsl.toWindowsPath(installDir);
		// The new distro's VHDX must live on a Windows drive, not inside another distro.
		if (wsl.isInsideDistro(installPath)) {
			vscode.window.showErrorMessage(
				vscode.l10n.t('Cannot install into {0}. Choose a folder on a Windows drive (for example under /mnt/c or C:\\).', installPath),
			);
			return;
		}

		const isVhd = sourcePath.toLowerCase().endsWith('.vhdx');
		const distroName = name.trim();
		// WSL creates ext4.vhdx in the install folder; it ends up close to the source's size.
		const sourceSize = await wsl.toHostPath(sourcePath).then((p) => fs.stat(p)).then((st) => st.size, () => undefined);
		const vhdxHost = path.join(await wsl.toHostPath(installPath), 'ext4.vhdx');
		const imported = await withFileProgress(vscode.l10n.t('Importing {0}', distroName), vhdxHost, sourceSize, (signal) =>
			wsl.importDistro(distroName, installPath, sourcePath, isVhd, signal),
		);
		tree.refresh();
		if (imported === undefined) {
			// WSL undoes a cancelled import itself; make sure nothing is left registered.
			if ((await wsl.list()).some((d) => d.name.toLowerCase() === distroName.toLowerCase())) {
				await wsl.unregister(distroName).catch(() => undefined);
				tree.refresh();
			}
			vscode.window.showInformationMessage(vscode.l10n.t('Import of "{0}" cancelled.', distroName));
			return;
		}
		vscode.window.showInformationMessage(vscode.l10n.t('Distro "{0}" imported.', distroName));
	});

	register('wslManager.unregister', async (arg: unknown) => {
		const distro = await resolveDistro(arg, vscode.l10n.t('Unregister which distro?'));
		if (!distro) {
			return;
		}
		// Unregister deletes the whole disk and cannot be undone: require typing the name.
		const typed = await promptText({
			title: vscode.l10n.t('Permanently unregister "{0}"', distro.name),
			prompt: [
				vscode.l10n.t('This deletes ALL data in "{0}".', distro.name),
				...distroWarnings(distro.name),
				vscode.l10n.t('Type the name to confirm.'),
			].join(' '),
			placeHolder: distro.name,
			validateInput: (value) =>
				value === distro.name ? undefined : vscode.l10n.t('Type exactly: {0}', distro.name),
		});
		if (typed !== distro.name) {
			return;
		}
		await withProgress(vscode.l10n.t('Unregistering {0}...', distro.name), async () => {
			await wsl.unregister(distro.name);
			await healInteropAfterStop();
		});
		vscode.window.showInformationMessage(vscode.l10n.t('"{0}" was unregistered.', distro.name));
		tree.refresh();
	});

	register('wslManager.shutdown', async () => {
		const message =
			vscode.l10n.t('Shut down WSL? Every running distro will be stopped immediately, including VS Code windows connected to them.');
		const current = wsl.currentWindowDistro();
		const ok = current
			? await confirmDistroAction(current, message, vscode.l10n.t('Shut Down WSL'))
			: await confirmDestructive(message, vscode.l10n.t('Shut Down WSL'));
		if (!ok) {
			return;
		}
		await withProgress(vscode.l10n.t('Shutting down WSL...'), () => wsl.shutdown());
		// The VM stopped, so a saved .wslconfig applies when it starts again.
		await clearPending();
		tree.refresh();
	});

	register('wslManager.restartWsl', async () => {
		const distros = await wsl.list();
		const running = distros.filter((d) => d.running).map((d) => d.name);
		const toStart = wsl.distrosToStartAgain(distros);
		const managed = running.filter((name) => wsl.managedBy(name));
		const connected = await wsl.vscodeConnectedDistros().catch(() => []);
		const detail = [
			running.length > 0
				? vscode.l10n.t('Running now: {0}. They stop and start again; stopped distros stay stopped.', running.join(', '))
				: vscode.l10n.t('No distro is running; they all stay stopped.'),
			managed.length > 0
				? vscode.l10n.t('{0} belong to Docker, Podman, or Rancher Desktop and are not started again; start them from that tool.', managed.join(', '))
				: '',
			connected.length > 0
				? vscode.l10n.t('VS Code windows connected to {0} lose their connection; if one does not reconnect, run "Developer: Reload Window" in it.', connected.join(', '))
				: '',
			vscode.l10n.t('Every WSL terminal will be closed. Windows does not restart.'),
		].filter(Boolean);
		const label = vscode.l10n.t('Restart WSL');
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t('Restart WSL to apply .wslconfig?'),
			{ modal: true, detail: detail.join('\n\n') },
			label,
		);
		if (choice !== label) {
			return;
		}
		await withProgress(vscode.l10n.t('Restarting WSL...'), async () => {
			await wsl.shutdown();
			await clearPending();
			for (const name of toStart) {
				await wsl.start(name).catch(() => undefined);
			}
		});
		tree.invalidateDetails();
		tree.refresh();
		vscode.window.showInformationMessage(
			toStart.length > 0
				? vscode.l10n.t('WSL restarted with the new .wslconfig; {0} started again.', toStart.join(', '))
				: vscode.l10n.t('WSL restarted; the new .wslconfig applies from the next distro you start.'),
		);
	});

	register('wslManager.editWslConfig', async () => {
		const doc = await vscode.workspace.openTextDocument(globalUri());
		await vscode.window.showTextDocument(doc);
	});

	register('wslManager.compact', async (arg: unknown) => {
		const distro = await resolveDistro(arg, vscode.l10n.t('Compact the disk of which distro?'), (d) => d.version === 2);
		if (!distro) {
			return;
		}
		if (distro.version !== 2) {
			vscode.window.showInformationMessage(vscode.l10n.t('Only WSL 2 distros have a virtual disk to compact.'));
			return;
		}
		const { vhd, vhdHost, size: sizeBefore } = await distroDisk(distro);
		if (await refuseIfShutdownWouldDisconnect(distro, vhd)) {
			return;
		}

		// Only a running distro can report what it uses; say what to expect.
		const used = distro.running ? (await wsl.runtimeInfo(distro.name).catch(() => undefined))?.diskUsed : undefined;
		const reclaimable = estimateReclaimable(sizeBefore, used);
		const expectation =
			used === undefined
				? vscode.l10n.t('The distro is stopped, so the space to reclaim cannot be estimated.')
				: reclaimable !== undefined
					? vscode.l10n.t('About {0} can be reclaimed.', formatBytes(reclaimable))
					: vscode.l10n.t('Little to reclaim: the disk holds {0} and is only {1} larger, which is mostly file system overhead. Compacting now will likely gain almost nothing.', formatBytes(used), formatBytes(sizeBefore - used));

		const ok = await confirmDistroAction(
			distro.name,
			vscode.l10n.t('Compact the disk of "{0}" ({1})?', distro.name, formatBytes(sizeBefore)),
			vscode.l10n.t('Compact'),
			`${expectation}\n\n` +
				(distro.running ? vscode.l10n.t('The distro will be stopped while its disk is compacted, then started again. ') : '') +
				vscode.l10n.t('Windows will ask for administrator permission to run diskpart.'),
		);
		if (!ok) {
			return;
		}

		let restart: string[] = [];
		try {
			const release = await releaseDisk(
				distro,
				vhd,
				{
					progress: vscode.l10n.t('Compacting {0}: releasing the disk...', distro.name),
					shutdownTitle: vscode.l10n.t('Shut down WSL to compact "{0}"?', distro.name),
					shutdownLabel: vscode.l10n.t('Shut Down and Compact'),
					shutdownDetail:
						reclaimable !== undefined ? vscode.l10n.t('Expected gain: about {0}.', formatBytes(reclaimable)) : undefined,
				},
				// WSL mounts with discard, so this mostly catches leftovers; it is cheap.
				() =>
					wsl
						.run(['--distribution', distro.name, '--user', 'root', '--exec', '/bin/sh', '-c', 'fstrim -a'], {
							tolerateFailure: true,
						})
						.then(() => undefined),
			);
			restart = release.restart;
			if (!release.released) {
				return;
			}

			const started = Date.now();
			const result = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: vscode.l10n.t('Compacting {0} ({1})', distro.name, formatBytes(sizeBefore)),
				},
				async (progress) => {
					progress.report({ message: vscode.l10n.t('waiting for administrator permission...') });
					// diskpart reports no progress; show elapsed time so a long run does not look stuck.
					const timer = setInterval(() => {
						progress.report({
							message: vscode.l10n.t('running diskpart, {0} elapsed. Large disks take several minutes.', formatElapsed(Date.now() - started)),
						});
					}, 1000);
					try {
						return await wsl.compactVhd(vhd);
					} finally {
						clearInterval(timer);
					}
				},
			);
			if (result.code !== 0) {
				const tail = result.log.trim().split(/\r?\n/).slice(-3).join(' ');
				throw new Error(vscode.l10n.t('diskpart failed (exit code {0}): {1}', result.code, tail));
			}
			const sizeAfter = (await fs.stat(vhdHost)).size;
			const saved = sizeBefore - sizeAfter;
			vscode.window.showInformationMessage(
				saved > 0
					? vscode.l10n.t('"{0}" compacted: {1} → {2} ({3} reclaimed).', distro.name, formatBytes(sizeBefore), formatBytes(sizeAfter), formatBytes(saved))
					: vscode.l10n.t('"{0}" was already compact ({1}).', distro.name, formatBytes(sizeAfter)),
			);
		} finally {
			await startAgain(restart);
			tree.invalidateDetails();
			tree.refresh();
		}
	});

	register('wslManager.move', async (arg: unknown) => {
		const distro = await resolveDistro(arg, vscode.l10n.t('Move which distro?'), (d) => d.version === 2 && !wsl.managedBy(d.name));
		if (!distro) {
			return;
		}
		if (distro.version !== 2) {
			vscode.window.showInformationMessage(vscode.l10n.t('Only WSL 2 distros can be moved.'));
			return;
		}
		const { vhd, size } = await distroDisk(distro);
		const dirs = await vscode.window.showOpenDialog({
			title: vscode.l10n.t('New folder for {0} ({1})', distro.name, formatBytes(size)),
			defaultUri: await wsl.dialogHomeUri(),
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
		});
		if (!dirs?.[0]) {
			return;
		}
		const destination = await wsl.toWindowsPath(dirs[0]);
		if (wsl.isInsideDistro(destination)) {
			vscode.window.showErrorMessage(vscode.l10n.t('Cannot move into {0}. Choose a folder on a Windows drive.', destination));
			return;
		}
		if (path.win32.resolve(destination).toLowerCase() === path.win32.dirname(vhd).toLowerCase()) {
			vscode.window.showInformationMessage(vscode.l10n.t('"{0}" is already in {1}.', distro.name, destination));
			return;
		}
		if (await refuseIfShutdownWouldDisconnect(distro, vhd)) {
			return;
		}
		const ok = await confirmDistroAction(
			distro.name,
			vscode.l10n.t('Move "{0}" ({1}) to {2}?', distro.name, formatBytes(size), destination),
			vscode.l10n.t('Move'),
			distro.running ? vscode.l10n.t('The distro will be stopped while its disk is copied, then started again.') : undefined,
		);
		if (!ok) {
			return;
		}

		let restart: string[] = [];
		try {
			const release = await releaseDisk(distro, vhd, {
				progress: vscode.l10n.t('Moving {0}: releasing the disk...', distro.name),
				shutdownTitle: vscode.l10n.t('Shut down WSL to move "{0}"?', distro.name),
				shutdownLabel: vscode.l10n.t('Shut Down and Move'),
			});
			restart = release.restart;
			if (!release.released) {
				return;
			}
			const target = path.join(await wsl.toHostPath(destination), path.win32.basename(vhd));
			const moved = await withFileProgress(vscode.l10n.t('Moving {0} to {1}', distro.name, destination), target, size, (signal) =>
				wsl.moveDistro(distro.name, destination, signal),
			);
			vscode.window.showInformationMessage(
				moved === undefined
					? vscode.l10n.t('Move cancelled; "{0}" stays in {1}.', distro.name, path.win32.dirname(vhd))
					: vscode.l10n.t('"{0}" moved to {1}.', distro.name, destination),
			);
		} finally {
			await startAgain(restart);
			tree.invalidateDetails();
			tree.refresh();
		}
	});

	register('wslManager.install', async () => {
		const online = await withProgress(vscode.l10n.t('Fetching the list of distros...'), () => wsl.listOnline());
		if (online.length === 0) {
			throw new Error(vscode.l10n.t('Could not read the list of installable distros (wsl --list --online).'));
		}
		const installed = new Set((await wsl.list()).map((d) => d.name.toLowerCase()));
		const picked = await vscode.window.showQuickPick(
			online.map((d) => ({
				label: d.name,
				description: d.friendlyName,
				detail: installed.has(d.name.toLowerCase()) ? vscode.l10n.t('Installed; pick a different name for another copy') : undefined,
				distro: d,
			})),
			{ title: vscode.l10n.t('Install a WSL distro'), placeHolder: vscode.l10n.t('Distro to install'), matchOnDescription: true },
		);
		if (!picked) {
			return;
		}
		const name = await promptText({
			title: vscode.l10n.t('Name for the new {0}', picked.distro.friendlyName),
			value: installed.has(picked.distro.name.toLowerCase()) ? `${picked.distro.name}-2` : picked.distro.name,
			validateInput: (value) => {
				const trimmed = value.trim();
				if (!trimmed) {
					return vscode.l10n.t('Enter a name.');
				}
				if (installed.has(trimmed.toLowerCase())) {
					return vscode.l10n.t('A distro with this name already exists.');
				}
				if (/[\\/:*?"<>|\s]/.test(trimmed)) {
					return vscode.l10n.t('The name cannot contain spaces or \\ / : * ? " < > |');
				}
				return undefined;
			},
		});
		if (!name) {
			return;
		}
		const where = await vscode.window.showQuickPick(
			[
				{ label: vscode.l10n.t('Default location'), description: vscode.l10n.t('Where WSL puts new distros'), choose: false },
				{ label: vscode.l10n.t('Choose a folder...'), description: vscode.l10n.t('For example on another drive'), choose: true },
			],
			{ title: vscode.l10n.t('Where to install {0}', name.trim()) },
		);
		if (!where) {
			return;
		}
		let location: string | undefined;
		if (where.choose) {
			const dirs = await vscode.window.showOpenDialog({
				title: vscode.l10n.t('Folder for {0}', name.trim()),
				defaultUri: await wsl.dialogHomeUri(),
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
			});
			if (!dirs?.[0]) {
				return;
			}
			location = await wsl.toWindowsPath(dirs[0]);
			if (wsl.isInsideDistro(location)) {
				vscode.window.showErrorMessage(vscode.l10n.t('Cannot install into {0}. Choose a folder on a Windows drive.', location));
				return;
			}
		}

		const done = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t('Installing {0} ({1})', name.trim(), picked.distro.friendlyName),
				cancellable: true,
			},
			async (progress, token) => {
				const controller = new AbortController();
				token.onCancellationRequested(() => controller.abort());
				const started = Date.now();
				const timer = setInterval(
					() => progress.report({ message: vscode.l10n.t('downloading and installing, {0}', formatElapsed(Date.now() - started)) }),
					1000,
				);
				try {
					await wsl.installDistro(picked.distro.name, name.trim(), location, controller.signal);
					return true;
				} catch (error) {
					if (error instanceof wsl.CancelledError) {
						return false;
					}
					throw error;
				} finally {
					clearInterval(timer);
				}
			},
		);
		tree.refresh();
		if (!done) {
			// A cancelled install may leave a half-registered distro behind.
			if ((await wsl.list()).some((d) => d.name.toLowerCase() === name.trim().toLowerCase())) {
				await wsl.unregister(name.trim()).catch(() => undefined);
				tree.refresh();
			}
			vscode.window.showInformationMessage(vscode.l10n.t('Installation of "{0}" cancelled.', name.trim()));
			return;
		}
		// --no-launch skips the first-run setup, which creates the default user.
		const choice = await vscode.window.showInformationMessage(
			vscode.l10n.t('"{0}" installed. Open a terminal to finish its setup (create the default user)?', name.trim()),
			vscode.l10n.t('Open Terminal'),
		);
		if (choice) {
			await vscode.commands.executeCommand('wslManager.openTerminal', name.trim());
		}
	});

	register('wslManager.repairInterop', async () => {
		const running = (await wsl.list()).filter((d) => d.running).map((d) => d.name);
		const restored = await withProgress(vscode.l10n.t('Checking Windows interop...'), () => wsl.restoreInterop(running));
		vscode.window.showInformationMessage(
			restored.length > 0
				? vscode.l10n.t('Restored Windows interop in {0}.', restored.join(', '))
				: vscode.l10n.t('Windows interop is working in every running distro.'),
		);
	});

	register('wslManager.copyName', async (arg: unknown) => {
		const distro = await resolveDistro(arg, vscode.l10n.t('Copy the name of which distro?'));
		if (!distro) {
			return;
		}
		await vscode.env.clipboard.writeText(distro.name);
	});

	registerTransferCommands(register, resolveDistro);
}
