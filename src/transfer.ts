import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatBytes } from './monitor';
import { withFileProgress, withProgress } from './progress';
import * as wsl from './wsl';
import { Distro } from './wsl';

export type BackupFormat = 'tar.gz' | 'zip';

export const DEFAULT_BACKUP_EXCLUDES = ['node_modules', '.venv', 'venv', '__pycache__', '.cache', 'target'];

/** `fedora-backup-20260923-213015.tar.gz`: sorts by date and never collides in practice. */
export function backupFileName(distro: string, date: Date, format: BackupFormat): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	const stamp =
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
		`${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	return `${distro.replace(/[\\/:*?"<>|]/g, '_')}-backup-${stamp}.${format}`;
}

/** "node_modules, .venv target" -> ['node_modules', '.venv', 'target'] */
export function parseExcludes(input: string): string[] {
	return [...new Set(input.split(/[,\s]+/).map((e) => e.trim()).filter(Boolean))];
}

/** A path that starts with "-" would be read as an option; "./-x" is the same file. */
function safePath(p: string): string {
	return p.startsWith('-') ? `./${p}` : p;
}

/**
 * The archiver's argv, run with `wsl --exec` from the user's home so no shell
 * parses paths or patterns. tar keeps permissions and symlinks; zip does not,
 * which is why .tar.gz is the default.
 */
export function backupCommand(format: BackupFormat, output: string, paths: string[], excludes: string[]): string[] {
	if (format === 'zip') {
		const patterns = excludes.flatMap((e) => [e, `${e}/*`, `*/${e}`, `*/${e}/*`]);
		return ['zip', '-r', '-q', '-y', output, ...paths.map(safePath), ...(patterns.length ? ['-x', ...patterns] : [])];
	}
	return ['tar', '-czf', output, ...excludes.map((e) => `--exclude=${e}`), '--', ...paths];
}

/**
 * Whether the archiver's exit code still means "archive written": tar exits 1
 * when a file changed while being read and 2 when some files could not be read;
 * zip exits 18 when some files could not be read. Those are warnings.
 */
export function backupOutcome(format: BackupFormat, code: number): 'ok' | 'warnings' | 'failed' {
	if (code === 0) {
		return 'ok';
	}
	const partial = format === 'zip' ? [18] : [1, 2];
	return partial.includes(code) ? 'warnings' : 'failed';
}

export function isArchive(file: string): BackupFormat | undefined {
	const lower = file.toLowerCase();
	if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
		return 'tar.gz';
	}
	return lower.endsWith('.zip') ? 'zip' : undefined;
}

export function extractCommand(format: BackupFormat, archive: string, folder: string): string[] {
	return format === 'zip' ? ['unzip', '-o', '-q', archive, '-d', folder] : ['tar', '-xzf', archive, '-C', folder];
}

type Register = (id: string, handler: (...args: any[]) => any) => void;
type ResolveDistro = (arg: unknown, placeHolder: string, filter?: (d: Distro) => boolean) => Promise<Distro | undefined>;

export function registerTransferCommands(register: Register, resolveDistro: ResolveDistro): void {
	register('wslManager.backup', async (arg: unknown) => {
		const distro = await resolveDistro(arg, vscode.l10n.t('Back up folders of which distro?'), (d) => !wsl.managedBy(d.name));
		if (!distro) {
			return;
		}
		const paths = await pickHomePaths(distro);
		if (!paths || paths.length === 0) {
			return;
		}

		const format = await vscode.window.showQuickPick(
			[
				{ label: '.tar.gz', description: vscode.l10n.t('Recommended: keeps permissions and symlinks'), format: 'tar.gz' as const },
				{ label: '.zip', description: vscode.l10n.t('Opens anywhere, but loses permissions and symlinks'), format: 'zip' as const },
			],
			{ title: vscode.l10n.t('Backup format') },
		);
		if (!format) {
			return;
		}
		if (format.format === 'zip' && !(await wsl.hasCommand(distro.name, 'zip'))) {
			vscode.window.showErrorMessage(
				vscode.l10n.t('zip is not installed in "{0}". Choose .tar.gz, or install zip in the distro first.', distro.name),
			);
			return;
		}

		const configured = vscode.workspace.getConfiguration('wslManager').get<string[]>('backupExcludes', DEFAULT_BACKUP_EXCLUDES);
		const excludesInput = await vscode.window.showInputBox({
			title: vscode.l10n.t('Leave out folders and files named'),
			prompt: vscode.l10n.t('Separated by commas or spaces, matched at any depth. Empty to include everything.'),
			value: configured.join(', '),
		});
		if (excludesInput === undefined) {
			return;
		}
		const excludes = parseExcludes(excludesInput);

		const folder = await pickBackupFolder();
		if (!folder) {
			return;
		}
		const fileName = backupFileName(distro.name, new Date(), format.format);
		const outWindows = path.win32.join(folder, fileName);
		const outHost = await wsl.toHostPath(outWindows);
		const outLinux = await wsl.linuxPathInDistro(distro.name, outWindows);

		const result = await withFileProgress(vscode.l10n.t('Backing up {0}', distro.name), outHost, undefined, (signal) =>
			wsl.runAsUser(distro.name, backupCommand(format.format, outLinux, paths, excludes), { signal }),
		);
		if (result === undefined) {
			await fs.rm(outHost, { force: true });
			vscode.window.showInformationMessage(vscode.l10n.t('Backup cancelled; the partial file was removed.'));
			return;
		}
		const outcome = backupOutcome(format.format, result.code);
		const size = await fs.stat(outHost).then((st) => st.size, () => undefined);
		if (outcome === 'failed' || size === undefined) {
			await fs.rm(outHost, { force: true });
			const reason = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-2).join(' ');
			throw new Error(vscode.l10n.t('Backup failed: {0}', reason || `exit code ${result.code}`));
		}
		const reveal = vscode.l10n.t('Show in Folder');
		const message =
			outcome === 'warnings'
				? vscode.l10n.t('Backup saved to {0} ({1}), but some files could not be read (permissions or files in use) and were left out.', outWindows, formatBytes(size))
				: vscode.l10n.t('Backup saved to {0} ({1}).', outWindows, formatBytes(size));
		const choice =
			outcome === 'warnings'
				? await vscode.window.showWarningMessage(message, reveal)
				: await vscode.window.showInformationMessage(message, reveal);
		if (choice === reveal) {
			await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outHost));
		}
	});

	register('wslManager.sendFiles', async (arg: unknown) => {
		const distro = await resolveDistro(arg, vscode.l10n.t('Send files to which distro?'), (d) => !wsl.managedBy(d.name));
		if (!distro) {
			return;
		}
		const files = await vscode.window.showOpenDialog({
			title: vscode.l10n.t('Files to send to {0}', distro.name),
			defaultUri: vscode.Uri.file(await wsl.toHostPath(await wsl.windowsDesktopDir()).catch(() => '')),
			canSelectMany: true,
			canSelectFiles: true,
			canSelectFolders: false,
		});
		if (!files || files.length === 0) {
			return;
		}
		const target = await vscode.window.showInputBox({
			title: vscode.l10n.t('Folder in {0}', distro.name),
			prompt: vscode.l10n.t('~ is your home. It must be a folder your user can write to; nothing runs with sudo.'),
			value: '~',
		});
		if (!target) {
			return;
		}
		const access = await wsl.userFolderAccess(distro.name, target.trim());
		if (access.state === 'denied') {
			vscode.window.showErrorMessage(
				vscode.l10n.t(
					'You do not have permission to write to {0} in "{1}"; it would need sudo, which this extension does not use. Choose a folder in your home, such as ~/Downloads.',
					access.path,
					distro.name,
				),
			);
			return;
		}

		const windowsPaths = await Promise.all(files.map((f) => wsl.toWindowsPath(f)));
		const names = windowsPaths.map((p) => path.win32.basename(p));
		const clashes = await wsl.existingNames(distro.name, access.path, names);
		let skip = new Set<string>();
		if (clashes.length > 0) {
			const overwrite = vscode.l10n.t('Overwrite');
			const skipLabel = vscode.l10n.t('Skip Existing');
			const choice = await vscode.window.showWarningMessage(
				vscode.l10n.t('{0} already exist in {1}.', clashes.join(', '), access.path),
				{ modal: true },
				overwrite,
				skipLabel,
			);
			if (!choice) {
				return;
			}
			if (choice === skipLabel) {
				skip = new Set(clashes);
			}
		}

		const sent: string[] = [];
		await withProgress(vscode.l10n.t('Sending files to {0}...', distro.name), async () => {
			for (const windowsPath of windowsPaths) {
				const name = path.win32.basename(windowsPath);
				if (skip.has(name)) {
					continue;
				}
				const source = await wsl.linuxPathInDistro(distro.name, windowsPath);
				const result = await wsl.runAsUser(distro.name, ['cp', '--', source, `${access.path}/${name}`]);
				if (result.code !== 0) {
					throw new Error(vscode.l10n.t('Could not copy {0}: {1}', name, result.stderr.trim()));
				}
				sent.push(name);
			}
		});
		if (sent.length === 0) {
			vscode.window.showInformationMessage(vscode.l10n.t('Nothing was sent: every file already existed.'));
			return;
		}

		// A backup made by this extension can be restored in place right away.
		const archives = sent.filter((name) => isArchive(name));
		const extract = vscode.l10n.t('Extract Here');
		const choice = await vscode.window.showInformationMessage(
			vscode.l10n.t('Sent {0} to {1} in "{2}".', sent.join(', '), access.path, distro.name) +
				(archives.length > 0 ? ' ' + vscode.l10n.t('Extract the archives there? Files with the same names are overwritten.') : ''),
			...(archives.length > 0 ? [extract] : []),
		);
		if (choice !== extract) {
			return;
		}
		await withProgress(vscode.l10n.t('Extracting in {0}...', access.path), async () => {
			for (const name of archives) {
				const format = isArchive(name) as BackupFormat;
				if (format === 'zip' && !(await wsl.hasCommand(distro.name, 'unzip'))) {
					throw new Error(vscode.l10n.t('unzip is not installed in "{0}".', distro.name));
				}
				const result = await wsl.runAsUser(distro.name, extractCommand(format, `${access.path}/${name}`, access.path));
				if (result.code !== 0) {
					throw new Error(vscode.l10n.t('Could not extract {0}: {1}', name, result.stderr.trim()));
				}
			}
		});
		vscode.window.showInformationMessage(vscode.l10n.t('Extracted {0} in {1}.', archives.join(', '), access.path));
	});
}

/**
 * File dialogs cannot browse \\wsl.localhost (VS Code blocks UNC hosts), so
 * folders are picked from a list of the home folder, plus typed paths.
 */
async function pickHomePaths(distro: Distro): Promise<string[] | undefined> {
	const entries = await withProgress(vscode.l10n.t('Reading the home folder of {0}...', distro.name), () =>
		wsl.listHome(distro.name),
	);
	const typeItem = { label: `$(edit) ${vscode.l10n.t('Type paths...')}`, description: vscode.l10n.t('Relative to home or absolute'), typed: true };
	const picked = await vscode.window.showQuickPick(
		[
			typeItem,
			...entries
				.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
				.map((e) => ({ label: `$(${e.isDir ? 'folder' : 'file'}) ${e.name}`, name: e.name, typed: false })),
		],
		{
			canPickMany: true,
			title: vscode.l10n.t('What to back up from the home of {0}', distro.name),
			placeHolder: vscode.l10n.t('Pick folders and files'),
		},
	);
	if (!picked) {
		return undefined;
	}
	const paths = picked.filter((p) => !p.typed).map((p) => (p as { name: string }).name);
	if (picked.some((p) => p.typed)) {
		const typed = await vscode.window.showInputBox({
			title: vscode.l10n.t('Paths to back up'),
			prompt: vscode.l10n.t('Separated by commas, relative to your home (projects/app) or absolute (/etc/nginx).'),
		});
		if (typed === undefined) {
			return undefined;
		}
		paths.push(...typed.split(',').map((p) => p.trim()).filter(Boolean));
	}
	return paths;
}

async function pickBackupFolder(): Promise<string | undefined> {
	const configured = vscode.workspace.getConfiguration('wslManager').get<string>('backupFolder', '');
	const desktop = await wsl.windowsDesktopDir().catch(() => undefined);
	const options = [
		...(configured ? [{ label: configured, description: vscode.l10n.t('Configured backup folder'), folder: configured }] : []),
		...(desktop && desktop !== configured ? [{ label: desktop, description: vscode.l10n.t('Desktop'), folder: desktop }] : []),
		{ label: `$(folder-opened) ${vscode.l10n.t('Choose a folder...')}`, description: '', folder: '' },
	];
	const picked = await vscode.window.showQuickPick(options, { title: vscode.l10n.t('Where to save the backup') });
	if (!picked) {
		return undefined;
	}
	if (picked.folder) {
		return picked.folder;
	}
	const dirs = await vscode.window.showOpenDialog({
		title: vscode.l10n.t('Where to save the backup'),
		defaultUri: await wsl.dialogHomeUri(),
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
	});
	if (!dirs?.[0]) {
		return undefined;
	}
	const chosen = await wsl.toWindowsPath(dirs[0]);
	if (wsl.isInsideDistro(chosen)) {
		vscode.window.showErrorMessage(vscode.l10n.t('Choose a folder on a Windows drive.'));
		return undefined;
	}
	return chosen;
}
