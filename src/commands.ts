import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import * as wsl from './wsl';
import { Distro } from './wsl';
import { formatBytes } from './monitor';
import { DistroItem, DistroTreeProvider, InfoItem, estimateReclaimable } from './tree';
import { distroUri, globalUri } from './configFs';

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
		vscode.window.showInformationMessage('No WSL distro available for this action.');
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(
		distros.map((d) => ({
			label: d.name,
			description: `WSL ${d.version} · ${d.running ? 'Running' : 'Stopped'}${d.isDefault ? ' · default' : ''}`,
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

const WINDOW_WARNING =
	'This VS Code window is connected to it and will be disconnected.';

/** Reasons an action on this distro deserves a warning no setting can turn off. */
function distroWarnings(distro: string): string[] {
	const warnings: string[] = [];
	if (wsl.isCurrentWindowDistro(distro)) {
		warnings.push(`"${distro}" is the distro of this window. ${WINDOW_WARNING}`);
	}
	const managed = wsl.managedBy(distro);
	if (managed) {
		warnings.push(`"${distro}" is managed by ${managed.tool}; changing it here can break ${managed.tool}. ${managed.hint}`);
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
		{ modal: true, detail: `"${distro}" is managed by ${managed.tool}. ${managed.hint}` },
		confirmLabel,
	);
	return choice === confirmLabel;
}

/** Confirms restarting the current window's distro; any other distro passes through. */
export async function confirmRestartIfCurrentWindow(distro: string): Promise<boolean> {
	if (!wsl.isCurrentWindowDistro(distro)) {
		return true;
	}
	const choice = await vscode.window.showWarningMessage(
		`Restart "${distro}"?`,
		{ modal: true, detail: `"${distro}" is the distro of this window. ${WINDOW_WARNING}` },
		'Restart',
	);
	return choice === 'Restart';
}

/**
 * Always asks: a shutdown stops every distro, including ones other tools
 * (Docker, Podman) depend on, and those are not restarted for them.
 */
async function confirmShutdown(
	distro: string,
	verb: string,
	running: string[],
	detailLead?: string,
): Promise<boolean> {
	const managed = running.filter((name) => wsl.managedBy(name));
	const detail = [
		`WSL keeps the disk of "${distro}" attached while any distro is running.` + (detailLead ? ` ${detailLead}` : ''),
		running.length > 0
			? `Running now: ${running.join(', ')}. They will be stopped` +
				(running.length > managed.length ? ` and started again afterwards.` : '.')
			: '',
		managed.length > 0
			? `${managed.join(', ')} ${managed.length === 1 ? 'belongs' : 'belong'} to ${[
					...new Set(managed.map((name) => wsl.managedBy(name)?.tool)),
				].join(' / ')} and will not be restarted; start ${managed.length === 1 ? 'it' : 'them'} from that tool.`
			: '',
		'Every WSL terminal will be closed.',
	].filter(Boolean);
	const label = `Shut Down and ${verb[0].toUpperCase()}${verb.slice(1)}`;
	const choice = await vscode.window.showWarningMessage(
		`Shut down WSL to ${verb} "${distro}"?`,
		{ modal: true, detail: detail.join('\n\n') },
		label,
	);
	return choice === label;
}

/**
 * Stopping a distro unregisters Windows interop in the other running distros
 * (see wsl.restoreInterop). Put it back right after our own stops.
 */
async function healInteropAfterStop(): Promise<void> {
	const running = (await wsl.list()).filter((d) => d.running).map((d) => d.name);
	const restored = await wsl.restoreInterop(running).catch(() => []);
	if (restored.length > 0) {
		vscode.window.setStatusBarMessage(`$(check) Restored Windows interop in ${restored.join(', ')}`, 8000);
	}
}

/** The distro's VHDX, as Windows and as this host see it. */
async function distroDisk(distro: Distro): Promise<{ vhd: string; vhdHost: string; size: number }> {
	const registry = (await wsl.registryInfo()).get(distro.name);
	if (!registry?.basePath || !registry.vhdFileName) {
		throw new Error(`Could not find the virtual disk of "${distro.name}".`);
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
async function refuseIfShutdownWouldDisconnect(distro: Distro, vhd: string, action: string): Promise<boolean> {
	if (distro.running && process.platform !== 'win32' && wsl.isCurrentWindowDistro(distro.name)) {
		vscode.window.showWarningMessage(
			`This extension is running inside "${distro.name}", so it cannot stop it to ${action}. ` +
				'Run this command from a local VS Code window (not connected to WSL).',
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
		`To ${action}, WSL must shut down, which would disconnect the VS Code windows connected to ` +
			`${connected.join(', ')}. Nothing was changed.`,
		{ modal: true, detail: 'Close those windows, then run the command again from a local VS Code window.' },
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
	verb: string,
	options: { beforeStop?: () => Promise<void>; shutdownDetail?: string } = {},
): Promise<{ released: boolean; restart: string[] }> {
	let restart = distro.running ? [distro.name] : [];
	const free = await withProgress(`${verb[0].toUpperCase()}${verb.slice(1)} ${distro.name}: releasing the disk...`, async () => {
		if (distro.running) {
			await options.beforeStop?.();
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
			`The disk of "${distro.name}" stays attached while WSL is running, and shutting WSL down would stop ` +
				'this extension, which runs inside WSL. Run the command from a local VS Code window.',
		);
	}
	const running = (await wsl.list()).filter((d) => d.running).map((d) => d.name);
	if (!(await confirmShutdown(distro.name, verb, running, options.shutdownDetail))) {
		return { released: false, restart };
	}
	restart = [...new Set([...restart, ...running])].filter((name) => !wsl.managedBy(name));
	const released = await withProgress('Shutting down WSL...', async () => {
		await wsl.shutdown();
		return wsl.waitUntilUnlocked(vhd, 15000);
	});
	if (!released) {
		throw new Error(`The disk of "${distro.name}" is still in use by another program.`);
	}
	return { released: true, restart };
}

async function startAgain(names: string[]): Promise<void> {
	if (names.length === 0) {
		return;
	}
	await withProgress(`Starting ${names.join(', ')} again...`, async () => {
		for (const name of names) {
			await wsl.start(name).catch(() => undefined);
		}
	});
}

function formatElapsed(ms: number): string {
	const seconds = Math.round(ms / 1000);
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Cancellable progress for a wsl.exe operation that writes one growing file
 * (export, import, move). Resolves to undefined when the user cancels.
 */
async function withFileProgress<T>(
	title: string,
	file: string,
	expectedSize: number | undefined,
	task: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title, cancellable: true },
		async (progress, token) => {
			const controller = new AbortController();
			token.onCancellationRequested(() => controller.abort());
			const started = Date.now();
			let reported = 0;
			const timer = setInterval(() => {
				void fs.stat(file).then(
					(st) => {
						const written = `${formatBytes(st.size)} written, ${formatElapsed(Date.now() - started)}`;
						if (expectedSize) {
							const percent = Math.min(99, Math.floor((st.size / expectedSize) * 100));
							progress.report({ increment: Math.max(0, percent - reported), message: `~${percent}% · ${written}` });
							reported = Math.max(reported, percent);
						} else {
							progress.report({ message: written });
						}
					},
					() => progress.report({ message: `starting, ${formatElapsed(Date.now() - started)}` }),
				);
			}, 1000);
			try {
				return await task(controller.signal);
			} catch (error) {
				if (error instanceof wsl.CancelledError) {
					return undefined;
				}
				throw error;
			} finally {
				clearInterval(timer);
			}
		},
	);
}

function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title, cancellable: false },
		task,
	);
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
					vscode.window.showErrorMessage(`WSL: ${message}`);
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
		const distro = await resolveDistro(arg, 'Open which distro in a new window?');
		if (!distro) {
			return;
		}
		await vscode.commands.executeCommand('vscode.newWindow', {
			remoteAuthority: `wsl+${distro.name}`,
			reuseWindow: false,
		});
	});

	register('wslManager.openTerminal', async (arg: unknown) => {
		const distro = await resolveDistro(arg, 'Open a terminal in which distro?');
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
		const distro = await resolveDistro(arg, 'Start which distro?', (d) => !d.running);
		if (!distro) {
			return;
		}
		await withProgress(`Starting ${distro.name}...`, () => wsl.start(distro.name));
		tree.refresh();
	});

	register('wslManager.terminate', async (arg: unknown) => {
		const distro = await resolveDistro(arg, 'Stop which distro?', (d) => d.running);
		if (!distro) {
			return;
		}
		const ok = await confirmDistroAction(
			distro.name,
			`Stop "${distro.name}"? Processes running in this distro will be killed.`,
			'Stop',
		);
		if (!ok) {
			return;
		}
		await withProgress(`Stopping ${distro.name}...`, async () => {
			await wsl.terminate(distro.name);
			await healInteropAfterStop();
		});
		tree.refresh();
	});

	register('wslManager.restart', async (arg: unknown) => {
		const distro = await resolveDistro(arg, 'Restart which distro?');
		if (!distro) {
			return;
		}
		const ok = await confirmDistroAction(
			distro.name,
			`Restart "${distro.name}"? Running processes will be killed.`,
			'Restart',
		);
		if (!ok) {
			return;
		}
		await withProgress(`Restarting ${distro.name}...`, async () => {
			await wsl.terminate(distro.name);
			await wsl.start(distro.name);
		});
		tree.refresh();
	});

	register('wslManager.setDefault', async (arg: unknown) => {
		const distro = await resolveDistro(arg, 'Which distro should be the default?', (d) => !d.isDefault);
		if (!distro) {
			return;
		}
		if (!(await confirmIfManaged(distro.name, `Make "${distro.name}" the default distro?`, 'Set as Default'))) {
			return;
		}
		await wsl.setDefault(distro.name);
		vscode.window.showInformationMessage(`"${distro.name}" is now the default distro.`);
		tree.refresh();
	});

	register('wslManager.setVersion', async (arg: unknown) => {
		const distro = await resolveDistro(arg, 'Convert which distro?');
		if (!distro) {
			return;
		}
		const target = distro.version === 2 ? 1 : 2;
		const ok = await confirmDistroAction(
			distro.name,
			`Convert "${distro.name}" from WSL ${distro.version} to WSL ${target}? ` +
				'The conversion copies the entire file system and may take several minutes.',
			`Convert to WSL ${target}`,
		);
		if (!ok) {
			return;
		}
		await withProgress(`Converting ${distro.name} to WSL ${target}...`, () =>
			wsl.setVersion(distro.name, target as 1 | 2),
		);
		tree.refresh();
	});

	register('wslManager.export', async (arg: unknown) => {
		const distro = await resolveDistro(arg, 'Export which distro?');
		if (!distro) {
			return;
		}
		const home = await wsl.dialogHomeUri();
		const target = await vscode.window.showSaveDialog({
			title: `Export ${distro.name}`,
			defaultUri: vscode.Uri.joinPath(home, `${distro.name}.tar`),
			filters: { 'Tarball': ['tar'], 'Virtual disk': ['vhdx'] },
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
		const exported = await withFileProgress(`Exporting ${distro.name}`, targetHost, expected, (signal) =>
			wsl.exportDistro(distro.name, targetPath, isVhd, signal),
		);
		if (exported === undefined) {
			await fs.rm(targetHost, { force: true });
			vscode.window.showInformationMessage(`Export of "${distro.name}" cancelled; the partial file was removed.`);
			return;
		}
		vscode.window.showInformationMessage(`"${distro.name}" exported to ${targetPath}`);
	});

	register('wslManager.import', async () => {
		const home = await wsl.dialogHomeUri();
		const sources = await vscode.window.showOpenDialog({
			title: 'Select the exported file',
			defaultUri: home,
			canSelectMany: false,
			filters: { 'Exported distro': ['tar', 'vhdx'], 'All files': ['*'] },
		});
		const source = sources?.[0];
		if (!source) {
			return;
		}
		const sourcePath = await wsl.toWindowsPath(source);

		const existing = new Set((await wsl.list()).map((d) => d.name.toLowerCase()));
		const name = await vscode.window.showInputBox({
			title: 'Name of the new distro',
			value: path.win32.parse(sourcePath).name,
			validateInput: (value) => {
				const trimmed = value.trim();
				if (!trimmed) {
					return 'Enter a name.';
				}
				if (existing.has(trimmed.toLowerCase())) {
					return 'A distro with this name already exists.';
				}
				if (/[\\/:*?"<>|]/.test(trimmed)) {
					return 'The name cannot contain \\ / : * ? " < > |';
				}
				return undefined;
			},
		});
		if (!name) {
			return;
		}

		const dirs = await vscode.window.showOpenDialog({
			title: 'Folder where the distro disk will be created',
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
				`Cannot install into ${installPath}. Choose a folder on a Windows drive (for example under /mnt/c or C:\\).`,
			);
			return;
		}

		const isVhd = sourcePath.toLowerCase().endsWith('.vhdx');
		const distroName = name.trim();
		// WSL creates ext4.vhdx in the install folder; it ends up close to the source's size.
		const sourceSize = await wsl.toHostPath(sourcePath).then((p) => fs.stat(p)).then((st) => st.size, () => undefined);
		const vhdxHost = path.join(await wsl.toHostPath(installPath), 'ext4.vhdx');
		const imported = await withFileProgress(`Importing ${distroName}`, vhdxHost, sourceSize, (signal) =>
			wsl.importDistro(distroName, installPath, sourcePath, isVhd, signal),
		);
		tree.refresh();
		if (imported === undefined) {
			// WSL undoes a cancelled import itself; make sure nothing is left registered.
			if ((await wsl.list()).some((d) => d.name.toLowerCase() === distroName.toLowerCase())) {
				await wsl.unregister(distroName).catch(() => undefined);
				tree.refresh();
			}
			vscode.window.showInformationMessage(`Import of "${distroName}" cancelled.`);
			return;
		}
		vscode.window.showInformationMessage(`Distro "${distroName}" imported.`);
	});

	register('wslManager.unregister', async (arg: unknown) => {
		const distro = await resolveDistro(arg, 'Unregister which distro?');
		if (!distro) {
			return;
		}
		// Unregister deletes the whole disk and cannot be undone: require typing the name.
		const typed = await vscode.window.showInputBox({
			title: `Permanently unregister "${distro.name}"`,
			prompt: [`This deletes ALL data in "${distro.name}".`, ...distroWarnings(distro.name), 'Type the name to confirm.'].join(' '),
			placeHolder: distro.name,
			validateInput: (value) =>
				value === distro.name ? undefined : `Type exactly: ${distro.name}`,
		});
		if (typed !== distro.name) {
			return;
		}
		await withProgress(`Unregistering ${distro.name}...`, async () => {
			await wsl.unregister(distro.name);
			await healInteropAfterStop();
		});
		vscode.window.showInformationMessage(`"${distro.name}" was unregistered.`);
		tree.refresh();
	});

	register('wslManager.shutdown', async () => {
		const message =
			'Shut down WSL? Every running distro will be stopped immediately, ' +
			'including VS Code windows connected to them.';
		const current = wsl.currentWindowDistro();
		const ok = current
			? await confirmDistroAction(current, message, 'Shut Down WSL')
			: await confirmDestructive(message, 'Shut Down WSL');
		if (!ok) {
			return;
		}
		await withProgress('Shutting down WSL...', () => wsl.shutdown());
		tree.refresh();
	});

	register('wslManager.editWslConfig', async () => {
		const doc = await vscode.workspace.openTextDocument(globalUri());
		await vscode.window.showTextDocument(doc);
	});

	register('wslManager.editWslConf', async (arg: unknown) => {
		const distro = await resolveDistro(arg, 'Edit wsl.conf of which distro?');
		if (!distro) {
			return;
		}
		if (!(await confirmIfManaged(distro.name, `Edit /etc/wsl.conf of "${distro.name}"?`, 'Edit'))) {
			return;
		}
		const doc = await vscode.workspace.openTextDocument(distroUri(distro.name));
		await vscode.window.showTextDocument(doc);
	});

	register('wslManager.compact', async (arg: unknown) => {
		const distro = await resolveDistro(arg, 'Compact the disk of which distro?', (d) => d.version === 2);
		if (!distro) {
			return;
		}
		if (distro.version !== 2) {
			vscode.window.showInformationMessage('Only WSL 2 distros have a virtual disk to compact.');
			return;
		}
		const { vhd, vhdHost, size: sizeBefore } = await distroDisk(distro);
		if (await refuseIfShutdownWouldDisconnect(distro, vhd, `compact "${distro.name}"`)) {
			return;
		}

		// Only a running distro can report what it uses; say what to expect.
		const used = distro.running ? (await wsl.runtimeInfo(distro.name).catch(() => undefined))?.diskUsed : undefined;
		const reclaimable = estimateReclaimable(sizeBefore, used);
		const expectation =
			used === undefined
				? 'The distro is stopped, so the space to reclaim cannot be estimated.'
				: reclaimable !== undefined
					? `About ${formatBytes(reclaimable)} can be reclaimed.`
					: `Little to reclaim: the disk holds ${formatBytes(used)} and is only ${formatBytes(sizeBefore - used)} larger, ` +
						'which is mostly file system overhead. Compacting now will likely gain almost nothing.';

		const ok = await confirmDistroAction(
			distro.name,
			`Compact the disk of "${distro.name}" (${formatBytes(sizeBefore)})?`,
			'Compact',
			`${expectation}\n\n` +
				(distro.running ? 'The distro will be stopped while its disk is compacted, then started again. ' : '') +
				'Windows will ask for administrator permission to run diskpart.',
		);
		if (!ok) {
			return;
		}

		let restart: string[] = [];
		try {
			const release = await releaseDisk(distro, vhd, 'compact', {
				// WSL mounts with discard, so this mostly catches leftovers; it is cheap.
				beforeStop: () =>
					wsl
						.run(['--distribution', distro.name, '--user', 'root', '--exec', '/bin/sh', '-c', 'fstrim -a'], {
							tolerateFailure: true,
						})
						.then(() => undefined),
				shutdownDetail: reclaimable !== undefined ? `Expected gain: about ${formatBytes(reclaimable)}.` : undefined,
			});
			restart = release.restart;
			if (!release.released) {
				return;
			}

			const started = Date.now();
			const result = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Compacting ${distro.name} (${formatBytes(sizeBefore)})`,
				},
				async (progress) => {
					progress.report({ message: 'waiting for administrator permission...' });
					// diskpart reports no progress; show elapsed time so a long run does not look stuck.
					const timer = setInterval(() => {
						progress.report({
							message: `running diskpart, ${formatElapsed(Date.now() - started)} elapsed. Large disks take several minutes.`,
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
				throw new Error(`diskpart failed (exit code ${result.code}): ${tail}`);
			}
			const sizeAfter = (await fs.stat(vhdHost)).size;
			const saved = sizeBefore - sizeAfter;
			vscode.window.showInformationMessage(
				saved > 0
					? `"${distro.name}" compacted: ${formatBytes(sizeBefore)} → ${formatBytes(sizeAfter)} (${formatBytes(saved)} reclaimed).`
					: `"${distro.name}" was already compact (${formatBytes(sizeAfter)}).`,
			);
		} finally {
			await startAgain(restart);
			tree.invalidateDetails();
			tree.refresh();
		}
	});

	register('wslManager.move', async (arg: unknown) => {
		const distro = await resolveDistro(arg, 'Move which distro?', (d) => d.version === 2 && !wsl.managedBy(d.name));
		if (!distro) {
			return;
		}
		if (distro.version !== 2) {
			vscode.window.showInformationMessage('Only WSL 2 distros can be moved.');
			return;
		}
		const { vhd, size } = await distroDisk(distro);
		const dirs = await vscode.window.showOpenDialog({
			title: `New folder for ${distro.name} (${formatBytes(size)})`,
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
			vscode.window.showErrorMessage(`Cannot move into ${destination}. Choose a folder on a Windows drive.`);
			return;
		}
		if (path.win32.resolve(destination).toLowerCase() === path.win32.dirname(vhd).toLowerCase()) {
			vscode.window.showInformationMessage(`"${distro.name}" is already in ${destination}.`);
			return;
		}
		if (await refuseIfShutdownWouldDisconnect(distro, vhd, `move "${distro.name}"`)) {
			return;
		}
		const ok = await confirmDistroAction(
			distro.name,
			`Move "${distro.name}" (${formatBytes(size)}) to ${destination}?`,
			'Move',
			distro.running ? 'The distro will be stopped while its disk is copied, then started again.' : undefined,
		);
		if (!ok) {
			return;
		}

		let restart: string[] = [];
		try {
			const release = await releaseDisk(distro, vhd, 'move');
			restart = release.restart;
			if (!release.released) {
				return;
			}
			const target = path.join(await wsl.toHostPath(destination), path.win32.basename(vhd));
			const moved = await withFileProgress(`Moving ${distro.name} to ${destination}`, target, size, (signal) =>
				wsl.moveDistro(distro.name, destination, signal),
			);
			vscode.window.showInformationMessage(
				moved === undefined
					? `Move cancelled; "${distro.name}" stays in ${path.win32.dirname(vhd)}.`
					: `"${distro.name}" moved to ${destination}.`,
			);
		} finally {
			await startAgain(restart);
			tree.invalidateDetails();
			tree.refresh();
		}
	});

	register('wslManager.install', async () => {
		const online = await withProgress('Fetching the list of distros...', () => wsl.listOnline());
		if (online.length === 0) {
			throw new Error('Could not read the list of installable distros (wsl --list --online).');
		}
		const installed = new Set((await wsl.list()).map((d) => d.name.toLowerCase()));
		const picked = await vscode.window.showQuickPick(
			online.map((d) => ({
				label: d.name,
				description: d.friendlyName,
				detail: installed.has(d.name.toLowerCase()) ? 'Installed; pick a different name for another copy' : undefined,
				distro: d,
			})),
			{ title: 'Install a WSL distro', placeHolder: 'Distro to install', matchOnDescription: true },
		);
		if (!picked) {
			return;
		}
		const name = await vscode.window.showInputBox({
			title: `Name for the new ${picked.distro.friendlyName}`,
			value: installed.has(picked.distro.name.toLowerCase()) ? `${picked.distro.name}-2` : picked.distro.name,
			validateInput: (value) => {
				const trimmed = value.trim();
				if (!trimmed) {
					return 'Enter a name.';
				}
				if (installed.has(trimmed.toLowerCase())) {
					return 'A distro with this name already exists.';
				}
				if (/[\\/:*?"<>|\s]/.test(trimmed)) {
					return 'The name cannot contain spaces or \\ / : * ? " < > |';
				}
				return undefined;
			},
		});
		if (!name) {
			return;
		}
		const where = await vscode.window.showQuickPick(
			[
				{ label: 'Default location', description: 'Where WSL puts new distros', choose: false },
				{ label: 'Choose a folder...', description: 'For example on another drive', choose: true },
			],
			{ title: `Where to install ${name.trim()}` },
		);
		if (!where) {
			return;
		}
		let location: string | undefined;
		if (where.choose) {
			const dirs = await vscode.window.showOpenDialog({
				title: `Folder for ${name.trim()}`,
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
				vscode.window.showErrorMessage(`Cannot install into ${location}. Choose a folder on a Windows drive.`);
				return;
			}
		}

		const done = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Installing ${name.trim()} (${picked.distro.friendlyName})`,
				cancellable: true,
			},
			async (progress, token) => {
				const controller = new AbortController();
				token.onCancellationRequested(() => controller.abort());
				const started = Date.now();
				const timer = setInterval(
					() => progress.report({ message: `downloading and installing, ${formatElapsed(Date.now() - started)}` }),
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
			vscode.window.showInformationMessage(`Installation of "${name.trim()}" cancelled.`);
			return;
		}
		// --no-launch skips the first-run setup, which creates the default user.
		const choice = await vscode.window.showInformationMessage(
			`"${name.trim()}" installed. Open a terminal to finish its setup (create the default user)?`,
			'Open Terminal',
		);
		if (choice) {
			await vscode.commands.executeCommand('wslManager.openTerminal', name.trim());
		}
	});

	register('wslManager.repairInterop', async () => {
		const running = (await wsl.list()).filter((d) => d.running).map((d) => d.name);
		const restored = await withProgress('Checking Windows interop...', () => wsl.restoreInterop(running));
		vscode.window.showInformationMessage(
			restored.length > 0
				? `Restored Windows interop in ${restored.join(', ')}.`
				: 'Windows interop is working in every running distro.',
		);
	});

	register('wslManager.copyName', async (arg: unknown) => {
		const distro = await resolveDistro(arg, 'Copy the name of which distro?');
		if (!distro) {
			return;
		}
		await vscode.env.clipboard.writeText(distro.name);
	});
}
