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
 * Always asks: a shutdown stops every distro, including ones this window or
 * other tools (Docker, Podman) depend on, and those are not restarted for them.
 */
async function confirmShutdownForCompaction(
	distro: string,
	running: string[],
	reclaimable: number | undefined,
): Promise<boolean> {
	const managed = running.filter((name) => wsl.managedBy(name));
	const detail = [
		`WSL keeps the disk of "${distro}" attached while any distro is running.` +
			(reclaimable !== undefined ? ` Expected gain: about ${formatBytes(reclaimable)}.` : ''),
		running.length > 0
			? `Running now: ${running.join(', ')}. They will be stopped` +
				(running.length > managed.length ? ' and started again after the compaction.' : '.')
			: '',
		managed.length > 0
			? `${managed.join(', ')} ${managed.length === 1 ? 'belongs' : 'belong'} to ${[
					...new Set(managed.map((name) => wsl.managedBy(name)?.tool)),
				].join(' / ')} and will not be restarted; start ${managed.length === 1 ? 'it' : 'them'} from that tool.`
			: '',
		'Every WSL terminal will be closed. Compacting a large disk can take several minutes.',
	].filter(Boolean);
	const choice = await vscode.window.showWarningMessage(
		`Shut down WSL to compact "${distro}"?`,
		{ modal: true, detail: detail.join('\n\n') },
		'Shut Down and Compact',
	);
	return choice === 'Shut Down and Compact';
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
		await withProgress(`Exporting ${distro.name}...`, () =>
			wsl.exportDistro(distro.name, targetPath, isVhd),
		);
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
		await withProgress(`Importing ${name.trim()}...`, () =>
			wsl.importDistro(name.trim(), installPath, sourcePath, isVhd),
		);
		vscode.window.showInformationMessage(`Distro "${name.trim()}" imported.`);
		tree.refresh();
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
		// Stopping the distro would kill this very extension host halfway through.
		if (distro.running && process.platform !== 'win32' && wsl.isCurrentWindowDistro(distro.name)) {
			vscode.window.showWarningMessage(
				`This extension is running inside "${distro.name}", so it cannot stop it to compact its disk. ` +
					'Run this command from a local VS Code window (not connected to WSL) or from another distro.',
			);
			return;
		}
		// Current WSL releases a disk only when the whole VM shuts down, which kills
		// every VS Code window connected to WSL; those do not reliably reconnect.
		// Check before touching anything, and never do that to open windows.
		const connected = await wsl.vscodeConnectedDistros().catch(() => []);
		if (connected.length > 0) {
			vscode.window.showWarningMessage(
				`Compacting "${distro.name}" needs WSL to shut down, which would disconnect the VS Code ` +
					`windows connected to ${connected.join(', ')}. Nothing was changed.`,
				{ modal: true, detail: 'Close those windows, then run Compact Disk again from a local VS Code window.' },
			);
			return;
		}

		const registry = (await wsl.registryInfo()).get(distro.name);
		if (!registry?.basePath || !registry.vhdFileName) {
			throw new Error(`Could not find the virtual disk of "${distro.name}".`);
		}
		const vhd = path.win32.join(registry.basePath, registry.vhdFileName);
		const vhdHost = await wsl.toHostPath(vhd);
		const sizeBefore = (await fs.stat(vhdHost)).size;

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

		// Distros to start again at the end: this one, or everything a shutdown stopped.
		let toRestart = distro.running ? [distro.name] : [];
		const restart = async () => {
			for (const name of toRestart) {
				await wsl.start(name).catch(() => undefined);
			}
		};

		try {
			const free = await withProgress(`Compacting ${distro.name}: releasing the disk...`, async () => {
				if (distro.running) {
					// WSL mounts with discard, so this mostly catches leftovers; it is cheap.
					await wsl.run(
						['--distribution', distro.name, '--user', 'root', '--exec', '/bin/sh', '-c', 'fstrim -a'],
						{ tolerateFailure: true },
					);
					await wsl.terminate(distro.name);
					await healInteropAfterStop();
				}
				return wsl.waitUntilUnlocked(vhd, 5000);
			});

			if (!free) {
				// Current WSL keeps every VHDX attached while its VM runs, i.e. while
				// any distro runs. Only a full shutdown releases it.
				const running = (await wsl.list()).filter((d) => d.running).map((d) => d.name);
				if (process.platform !== 'win32') {
					throw new Error(
						`The disk of "${distro.name}" stays attached while WSL is running, and shutting WSL down ` +
							'would stop this extension, which runs inside WSL. Run Compact Disk from a local VS Code ' +
							'window (not connected to WSL).',
					);
				}
				if (!(await confirmShutdownForCompaction(distro.name, running, reclaimable))) {
					return;
				}
				toRestart = [...new Set([...toRestart, ...running])].filter((name) => !wsl.managedBy(name));
				const released = await withProgress('Shutting down WSL...', async () => {
					await wsl.shutdown();
					return wsl.waitUntilUnlocked(vhd, 15000);
				});
				if (!released) {
					throw new Error(`The disk of "${distro.name}" is still in use by another program.`);
				}
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
						const seconds = Math.round((Date.now() - started) / 1000);
						progress.report({
							message: `running diskpart, ${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed. Large disks take several minutes.`,
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
			const summary =
				saved > 0
					? `"${distro.name}" compacted: ${formatBytes(sizeBefore)} → ${formatBytes(sizeAfter)} (${formatBytes(saved)} reclaimed).`
					: `"${distro.name}" was already compact (${formatBytes(sizeAfter)}).`;
			vscode.window.showInformationMessage(summary);
		} finally {
			if (toRestart.length > 0) {
				await withProgress(`Starting ${toRestart.join(', ')} again...`, restart);
			}
			tree.invalidateDetails();
			tree.refresh();
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
