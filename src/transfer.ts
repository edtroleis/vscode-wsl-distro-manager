import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatBytes } from './monitor';
import { withFileProgress, withProgress } from './progress';
import { promptText } from './prompts';
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

/** Home entries that usually hold credentials: keys, cloud and cluster tokens. */
const SENSITIVE_NAMES = new Set([
	'.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.netrc', '.git-credentials',
	'.password-store', '.vault-token', '.npmrc', '.pypirc',
]);

/**
 * The chosen paths that are, or sit inside, a folder that usually holds
 * credentials (".ssh", "projects/.aws", "/root/.kube/config"), plus the
 * credential folders of the home folder when all of it is chosen (".").
 */
export function sensitivePaths(paths: string[], homeNames: string[] = []): string[] {
	const direct = paths.filter(
		(p) => p.split('/').some((part) => SENSITIVE_NAMES.has(part)) || /(^|\/)\.config\/gcloud(\/|$)/.test(p),
	);
	// The whole home folder takes its credential folders along.
	const viaHome = paths.includes('.') ? homeNames.filter((name) => SENSITIVE_NAMES.has(name)).map((name) => `~/${name}`) : [];
	return [...direct, ...viaHome];
}

/** A folder that a cloud client syncs, so a file saved there is uploaded. */
export function isCloudSynced(windowsFolder: string): boolean {
	return /\\(OneDrive|Dropbox|Google Drive|iCloudDrive)( - [^\\]+)?(\\|$)/i.test(windowsFolder);
}

/** The path of an entry of `folder`, relative to home ('.' is home itself). */
export function childPath(folder: string, name: string): string {
	return folder === '.' ? name : `${folder}/${name}`;
}

/** Whether `path` is `folder` itself or somewhere inside it. */
export function isWithin(path: string, folder: string): boolean {
	return folder === '.' || path === folder || path.startsWith(`${folder}/`);
}

/** Whether two lists hold the same keys, in any order. */
export function sameKeys(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((k) => b.includes(k));
}

/** Drops paths already covered by a selected folder above them. */
export function normalizeSelection(paths: string[]): string[] {
	const unique = [...new Set(paths)];
	return unique.filter((p) => !unique.some((other) => other !== p && isWithin(p, other)));
}

/**
 * Applies the checkboxes of one folder's view to the whole selection. The view
 * shows the folder itself ("Everything in ...") and its direct entries.
 * Checking "Everything" replaces anything chosen inside that folder; checking
 * an entry while "Everything" is checked switches to choosing entries.
 */
export function updateSelection(
	selected: string[],
	folder: string,
	viewKeys: string[],
	previouslyChecked: string[],
	nowChecked: string[],
): string[] {
	const rest = selected.filter((p) => !viewKeys.includes(p));
	const added = nowChecked.filter((k) => !previouslyChecked.includes(k));
	if (added.includes(folder)) {
		return normalizeSelection([...rest.filter((p) => !isWithin(p, folder)), folder]);
	}
	const entries = added.length > 0 ? nowChecked.filter((k) => k !== folder) : nowChecked;
	return normalizeSelection([...rest, ...entries]);
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
		const chosen = await pickHomePaths(distro);
		if (!chosen || chosen.paths.length === 0) {
			return;
		}
		const { paths } = chosen;

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
		const excludesInput = await promptText({
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
		// A backup is a plain archive: keys and tokens in it are readable by anyone
		// who gets the file, and a synced folder uploads it. Say so before writing.
		const sensitive = sensitivePaths(paths, chosen.homeNames);
		if (sensitive.length > 0) {
			const proceed = vscode.l10n.t('Back Up Anyway');
			const choice = await vscode.window.showWarningMessage(
				vscode.l10n.t('The backup includes {0}, which usually hold credentials (keys, tokens).', sensitive.join(', ')),
				{
					modal: true,
					detail:
						vscode.l10n.t('The archive is not encrypted: anyone who gets the file can read them.') +
						(isCloudSynced(folder)
							? ' ' + vscode.l10n.t('{0} is synced to the cloud, so the file will be uploaded there.', folder)
							: ''),
				},
				proceed,
			);
			if (choice !== proceed) {
				return;
			}
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
		const desktop = await wsl.windowsDesktopDir().then(wsl.toHostPath).catch(() => undefined);
		const files = await vscode.window.showOpenDialog({
			title: vscode.l10n.t('Files to send to {0}', distro.name),
			defaultUri: desktop ? vscode.Uri.file(desktop) : undefined,
			canSelectMany: true,
			canSelectFiles: true,
			canSelectFolders: false,
		});
		if (!files || files.length === 0) {
			return;
		}
		const target = await promptText({
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

		// Every question is asked here, in the same prompt sequence, before anything is sent.
		const clashes = await wsl.existingNames(distro.name, access.path, names);
		let skip = new Set<string>();
		if (clashes.length > 0) {
			const choice = await vscode.window.showQuickPick(
				[
					{ label: vscode.l10n.t('Overwrite them'), description: clashes.join(', '), overwrite: true },
					{ label: vscode.l10n.t('Skip them'), description: vscode.l10n.t('Send only the new files'), overwrite: false },
				],
				{ title: vscode.l10n.t('{0} already exist in {1}.', clashes.join(', '), access.path) },
			);
			if (!choice) {
				return;
			}
			if (!choice.overwrite) {
				skip = new Set(clashes);
			}
		}
		const toSend = windowsPaths.filter((p) => !skip.has(path.win32.basename(p)));
		if (toSend.length === 0) {
			vscode.window.showInformationMessage(vscode.l10n.t('Nothing was sent: every file already existed.'));
			return;
		}

		// Backups made by this extension can be restored in place right away.
		const archives = toSend.map((p) => path.win32.basename(p)).filter((name) => isArchive(name));
		let extract = false;
		if (archives.length > 0) {
			const choice = await vscode.window.showQuickPick(
				[
					{
						label: vscode.l10n.t('Send and extract'),
						description: vscode.l10n.t('Restores the backup in {0}; files with the same names are overwritten. Only for archives you trust.', access.path),
						extract: true,
					},
					{ label: vscode.l10n.t('Only send'), description: archives.join(', '), extract: false },
				],
				{ title: vscode.l10n.t('Extract {0} after sending?', archives.join(', ')) },
			);
			if (!choice) {
				return;
			}
			extract = choice.extract;
		}

		const sent: string[] = [];
		await withProgress(vscode.l10n.t('Sending files to {0}...', distro.name), async () => {
			for (const windowsPath of toSend) {
				const name = path.win32.basename(windowsPath);
				const source = await wsl.linuxPathInDistro(distro.name, windowsPath);
				const result = await wsl.runAsUser(distro.name, ['cp', '--', source, `${access.path}/${name}`]);
				if (result.code !== 0) {
					throw new Error(vscode.l10n.t('Could not copy {0}: {1}', name, result.stderr.trim()));
				}
				sent.push(name);
			}
			if (!extract) {
				return;
			}
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
		vscode.window.showInformationMessage(
			extract
				? vscode.l10n.t('Sent {0} to {1} in "{2}" and extracted {3}.', sent.join(', '), access.path, distro.name, archives.join(', '))
				: vscode.l10n.t('Sent {0} to {1} in "{2}".', sent.join(', '), access.path, distro.name),
		);
	});
}

interface PathItem extends vscode.QuickPickItem {
	key: string;
	isDir?: boolean;
}

/**
 * Picks what to back up from the default user's home. File dialogs cannot
 * browse \\wsl.localhost (VS Code blocks UNC hosts), so this is a quick pick
 * that navigates folders: checking a folder takes all of it; its ➔ button opens
 * it to choose items inside, where the first row takes the whole folder. The
 * ↑ button goes up. Choices in every folder are kept until OK. Typed paths
 * (relative or absolute) are asked for afterwards when "Type paths" is checked.
 */
export async function pickHomePaths(
	distro: Distro,
	listFolder: (distro: string, folder: string) => Promise<wsl.HomeEntry[]> = wsl.listFolder,
): Promise<{ paths: string[]; homeNames: string[] } | undefined> {
	const TYPED = '\0typed';
	const openButton: vscode.QuickInputButton = {
		iconPath: new vscode.ThemeIcon('arrow-right'),
		tooltip: vscode.l10n.t('Open, to choose items inside'),
	};
	const upButton: vscode.QuickInputButton = {
		iconPath: new vscode.ThemeIcon('arrow-up'),
		tooltip: vscode.l10n.t('Up one folder'),
	};
	let selected: string[] = [];
	let typed = false;
	let homeNames: string[] = [];
	let folder = '.';
	let viewKeys: string[] = [];
	// What the list shows as checked, as far as we know. VS Code reports
	// selection changes asynchronously, including the ones this code makes, so
	// an event matching it is an echo, not a click.
	let uiChecked: string[] = [];
	// Replacing the items (opening a folder) clears the checks and echoes that
	// too; until then, the list is kept in line with the selection instead.
	let settleUntil = 0;

	const pick = vscode.window.createQuickPick<PathItem>();
	pick.canSelectMany = true;
	pick.ignoreFocusOut = true;
	pick.matchOnDescription = false;

	const inherited = () => selected.some((p) => p !== folder && isWithin(folder, p));

	/** The checks this folder's view should show for the current selection. */
	const desiredChecks = (): string[] => {
		// A folder already taken whole through a folder above shows as such.
		const shown = inherited() ? [folder] : viewKeys.filter((k) => selected.includes(k));
		return typed && folder === '.' ? [TYPED, ...shown] : shown;
	};

	const showChecks = (keys: string[]) => {
		uiChecked = keys;
		pick.selectedItems = pick.items.filter((i) => keys.includes(i.key));
	};

	const updateText = () => {
		const count = selected.length + (typed ? 1 : 0);
		pick.title = vscode.l10n.t('Back up from {0}: ~/{1}', distro.name, folder === '.' ? '' : folder);
		pick.placeholder = inherited()
			? vscode.l10n.t('Already included through a folder above. Go up and uncheck it to choose items here.')
			: count > 0
				? vscode.l10n.t('{0} selected. Check to include; ➔ opens a folder; OK when done.', count)
				: vscode.l10n.t('Check to include; ➔ opens a folder to choose items inside; OK when done.');
	};

	/** Shows a folder's entries; only navigation replaces the items. */
	const render = (items: PathItem[]) => {
		viewKeys = items.filter((i) => i.key !== TYPED).map((i) => i.key);
		pick.buttons = folder === '.' ? [] : [upButton];
		pick.items = items;
		updateText();
		settleUntil = Date.now() + 500;
		showChecks(desiredChecks());
	};

	const open = async (target: string) => {
		pick.busy = true;
		const entries = await listFolder(distro.name, target).catch(() => []);
		pick.busy = false;
		folder = target;
		if (target === '.') {
			homeNames = entries.map((e) => e.name);
		}
		const everything: PathItem = {
			key: target,
			label: `$(check-all) ${target === '.' ? vscode.l10n.t('Everything in your home folder') : vscode.l10n.t('Everything in {0}/', target)}`,
		};
		const rows: PathItem[] = entries
			.sort((x, y) => Number(y.isDir) - Number(x.isDir) || x.name.localeCompare(y.name))
			.map((e) => ({
				key: childPath(target, e.name),
				label: `$(${e.isDir ? 'folder' : 'file'}) ${e.name}`,
				isDir: e.isDir,
				buttons: e.isDir ? [openButton] : undefined,
			}));
		const typeRow: PathItem = {
			key: TYPED,
			label: `$(edit) ${vscode.l10n.t('Type paths...')}`,
			description: vscode.l10n.t('Relative to home or absolute'),
		};
		render(target === '.' ? [typeRow, everything, ...rows] : [everything, ...rows]);
	};

	const result = await new Promise<string[] | undefined>((resolve) => {
		let done = false;
		pick.onDidChangeSelection((items) => {
			const keys = items.map((i) => i.key);
			if (sameKeys(keys, uiChecked)) {
				return;
			}
			if (Date.now() < settleUntil) {
				showChecks(desiredChecks());
				return;
			}
			const before = uiChecked.filter((k) => k !== TYPED);
			const now = keys.filter((k) => k !== TYPED);
			typed = keys.includes(TYPED);
			if (!inherited()) {
				selected = updateSelection(selected, folder, viewKeys, before, now);
			}
			uiChecked = keys;
			updateText();
			// Apply the rules ("Everything" vs. items) and undo clicks that cannot count.
			const desired = desiredChecks();
			if (!sameKeys(desired, keys)) {
				showChecks(desired);
			}
		});
		pick.onDidTriggerItemButton((e) => void open(e.item.key));
		pick.onDidTriggerButton((button) => {
			if (button === upButton) {
				const up = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '.';
				void open(up);
			}
		});
		pick.onDidAccept(() => {
			done = true;
			resolve(selected);
			pick.hide();
		});
		pick.onDidHide(() => {
			if (!done) {
				resolve(undefined);
			}
			pick.dispose();
		});
		pick.show();
		void open('.');
	});
	if (result === undefined) {
		return undefined;
	}

	const paths = [...result];
	if (typed) {
		const answer = await promptText({
			title: vscode.l10n.t('Paths to back up'),
			prompt: vscode.l10n.t('Separated by commas, relative to your home (projects/app) or absolute (/etc/nginx).'),
		});
		if (answer === undefined) {
			return undefined;
		}
		paths.push(...answer.split(',').map((p) => p.trim()).filter(Boolean));
	}
	return { paths: normalizeSelection(paths), homeNames };
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
