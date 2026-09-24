import { ChildProcess, spawn } from 'child_process';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface Distro {
	name: string;
	state: string;
	version: number;
	isDefault: boolean;
	running: boolean;
}

/**
 * wsl.exe writes UTF-16LE on most versions. WSL_UTF8=1 is supposed to change that,
 * but several builds ignore the variable for `--list --verbose`, so we decode by
 * inspecting the content: BOM first, then the interleaved NUL byte pattern.
 */
export function decode(buf: Buffer): string {
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
		return buf.toString('utf16le', 2);
	}
	if (buf.length >= 4 && buf[1] === 0x00 && buf[3] === 0x00) {
		return buf.toString('utf16le');
	}
	return buf.toString('utf8');
}

/**
 * A program in Windows' System32, by absolute path. Programs are never looked
 * up by bare name: a same-named executable earlier in the PATH (or, on older
 * runtimes, in the current folder) would run instead, and some of these run
 * with administrator rights after a UAC prompt.
 */
export function system32(program: string): string {
	if (process.platform !== 'win32') {
		return `/mnt/c/Windows/System32/${program.replace(/\\/g, '/')}`;
	}
	return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', program);
}

/** wslpath, by absolute path, when the extension runs inside WSL. */
const WSLPATH = '/usr/bin/wslpath';

export function wslExePath(): string {
	const configured = vscode.workspace.getConfiguration('wslManager').get<string>('wslExePath');
	// Even with extensionKind "ui" the host can be Linux when the window is
	// connected to a distro; system32() then points at wsl.exe through interop.
	return configured || system32('wsl.exe');
}

export interface RunOptions {
	stdin?: Buffer;
	/** Do not reject the promise when the process exits with a non-zero code. */
	tolerateFailure?: boolean;
	/** Kills the process when aborted; the promise then rejects with CancelledError. */
	signal?: AbortSignal;
}

/**
 * Thrown when a run is aborted. Killing the wsl.exe client really cancels the
 * operation in the WSL service: an export stops writing, and an import removes
 * its install folder and registers nothing (verified on WSL 2.7).
 */
export class CancelledError extends Error {
	constructor() {
		super('Cancelled');
		this.name = 'CancelledError';
	}
}

export interface RunResult {
	stdout: string;
	stderr: string;
	code: number;
}

export const interopBrokenMessage = () =>
	vscode.l10n.t(
		'Windows interop is disabled in this distro, so it cannot run wsl.exe. This is a known WSL issue: when a distro stops, interop is unregistered in every other running distro. Run "Repair Windows Interop" from a local VS Code window, or restore it here with: {0}',
		INTEROP_REPAIR_COMMAND,
	);

/**
 * On the Linux host, Windows programs run through a binfmt_misc entry that WSL
 * registers as WSLInterop (or WSLInterop-late). Without it, exec falls back to
 * running the .exe as a shell script, which fails with confusing messages.
 */
export function interopBroken(binfmtDir = '/proc/sys/fs/binfmt_misc'): boolean {
	if (process.platform === 'win32') {
		return false;
	}
	try {
		const entries = fsSync.readdirSync(binfmtDir);
		// Only judge when binfmt_misc is mounted (it always has "register").
		return entries.includes('register') && !entries.some((e) => e.startsWith('WSLInterop'));
	} catch {
		return false;
	}
}

/**
 * On Windows, wsl.exe hands the work to a child wsl.exe; killing only the
 * parent left an export writing and an import running. Kill the whole tree.
 * From the Linux side, killing the interop process already ends the tree.
 */
function killTree(child: ChildProcess): void {
	if (process.platform === 'win32' && child.pid !== undefined) {
		spawn(system32('taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on(
			'error',
			() => child.kill(),
		);
	} else {
		child.kill();
	}
}

function spawnCapture(
	command: string,
	args: string[],
	opts: RunOptions & { cwd?: string } = {},
): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: { ...process.env, WSL_UTF8: '1' },
			windowsHide: true,
			cwd: opts.cwd,
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on('data', (c: Buffer) => out.push(c));
		child.stderr.on('data', (c: Buffer) => err.push(c));
		child.on('error', reject);
		const onAbort = () => killTree(child);
		opts.signal?.addEventListener('abort', onAbort);
		if (opts.signal?.aborted) {
			killTree(child);
		}
		child.on('close', (code) => {
			opts.signal?.removeEventListener('abort', onAbort);
			if (opts.signal?.aborted) {
				reject(new CancelledError());
				return;
			}
			const result: RunResult = {
				stdout: decode(Buffer.concat(out)),
				stderr: decode(Buffer.concat(err)),
				code: code ?? -1,
			};
			if (result.code !== 0 && command.toLowerCase().endsWith('.exe') && interopBroken()) {
				reject(new Error(interopBrokenMessage()));
			} else if (result.code === 0 || opts.tolerateFailure) {
				resolve(result);
			} else {
				const message = (result.stderr || result.stdout).trim();
				reject(new Error(message || vscode.l10n.t('{0} exited with code {1}', command, result.code)));
			}
		});
		// Processes that never read stdin (wslpath, reg.exe) may close it before we
		// write; without this handler the EPIPE becomes an uncaught exception.
		child.stdin.on('error', () => undefined);
		child.stdin.end(opts.stdin ?? Buffer.alloc(0));
	});
}

/**
 * Long-running process inside the distro (for streaming metrics). The output
 * comes from the Linux program, not from wsl.exe, so it is plain UTF-8.
 */
export function spawnInDistro(distro: string, script: string): ChildProcess {
	const child = spawn(wslExePath(), ['--distribution', distro, '--exec', '/bin/sh', '-c', script], {
		env: { ...process.env, WSL_UTF8: '1' },
		windowsHide: true,
	});
	child.stdin?.on('error', () => undefined);
	child.stdin?.end();
	return child;
}

export function run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
	return spawnCapture(wslExePath(), args, opts);
}

const windowsDirs = new Map<string, string>();

/**
 * A Windows folder given by an environment variable (%USERPROFILE%, %TEMP%), as
 * seen by the current host.
 *
 * When the extension runs on the remote (Linux) host, os.homedir() would return
 * /home/<user>, which is not where .wslconfig lives. In that case we ask Windows
 * and translate with wslpath. The /mnt/c cwd avoids the UNC path warning that
 * cmd.exe prints when invoked from inside the Linux filesystem.
 */
async function windowsDir(variable: 'USERPROFILE' | 'TEMP'): Promise<string> {
	if (process.platform === 'win32') {
		return variable === 'USERPROFILE' ? os.homedir() : os.tmpdir();
	}
	const cached = windowsDirs.get(variable);
	if (cached) {
		return cached;
	}
	const echoed = await spawnCapture(system32('cmd.exe'), ['/c', `echo %${variable}%`], {
		cwd: '/mnt/c',
	});
	const windowsPath = echoed.stdout.trim();
	if (!windowsPath || windowsPath.includes(`%${variable}%`)) {
		throw new Error(vscode.l10n.t('Could not determine the Windows %{0}%.', variable));
	}
	const translated = (await spawnCapture(WSLPATH, ['-u', windowsPath])).stdout.trim();
	windowsDirs.set(variable, translated);
	return translated;
}

export const windowsHomeDir = () => windowsDir('USERPROFILE');
export const windowsTempDir = () => windowsDir('TEMP');

function lines(raw: string): string[] {
	return raw
		.split(/\r?\n/)
		.map((l) => l.replace(/\0/g, '').trim())
		.filter((l) => l.length > 0);
}

/**
 * The STATE column of `--list --verbose` is translated to the Windows display
 * language (and may contain spaces), so we never slice it by column position:
 * names come from `--list --quiet` and state from `--list --running --quiet`.
 * From the verbose output we only use the `*` marker and the last token, which
 * is always the version.
 */
export async function list(): Promise<Distro[]> {
	// With no distro installed, wsl.exe exits non-zero with a localized message
	// ("... has no installed distributions"), which must not be read as names.
	// A missing wsl.exe still throws (the process cannot start).
	const quietResult = await run(['--list', '--quiet'], { tolerateFailure: true });
	const quiet = quietResult.code === 0 ? quietResult.stdout : '';
	if (lines(quiet).length === 0) {
		return [];
	}

	// With no running distros, wsl.exe exits non-zero with an informational message.
	const runningResult = await run(['--list', '--running', '--quiet'], { tolerateFailure: true });
	const verbose = await run(['--list', '--verbose'], { tolerateFailure: true });
	return parseDistroList(quiet, runningResult.code === 0 ? runningResult.stdout : '', verbose.stdout);
}

/**
 * Pure part of list(): combines the decoded output of `--list --quiet`,
 * `--list --running --quiet` (empty when none is running), and `--list --verbose`.
 */
export function parseDistroList(quiet: string, running: string, verbose: string): Distro[] {
	const names = lines(quiet);
	const runningNames = new Set(lines(running));
	const verboseLines = lines(verbose).slice(1);

	return names.map((name) => {
		const row = verboseLines.find((l) => {
			const withoutMarker = l.replace(/^\*\s*/, '');
			return withoutMarker === name || withoutMarker.startsWith(`${name} `);
		});
		const version = row ? Number(row.split(/\s+/).pop()) : NaN;
		const running = runningNames.has(name);
		return {
			name,
			state: running ? 'Running' : 'Stopped',
			version: Number.isFinite(version) ? version : 2,
			isDefault: row ? row.startsWith('*') : false,
			running,
		};
	});
}

export const terminate = (name: string) => run(['--terminate', name]);
export const setDefault = (name: string) => run(['--set-default', name]);
export const shutdown = () => run(['--shutdown']);
export const unregister = (name: string) => run(['--unregister', name]);

/**
 * Boots the distro and keeps it running.
 *
 * WSL stops a distro about 15 s after its last wsl.exe session ends, even with
 * systemd, so booting it with a command that exits right away would undo
 * "Start" moments later. After booting (which surfaces errors), an idle
 * wsl.exe session keeps it alive until Stop, Restart, or shutdown ends it.
 *
 * That session is launched by PowerShell's Start-Process with a hidden window:
 * - spawning it from Node with `detached` leaves wsl.exe without a console, so
 *   it opens a new one, which Windows 11 shows as a Windows Terminal window;
 * - spawning it attached ties it to the extension host, and it dies with it.
 * The sleep takes no quotes, so no command-line escaping can mangle it.
 */
export async function start(name: string): Promise<void> {
	await run(['--distribution', name, '--exec', '/bin/true']);
	const quote = (a: string) => `'${a.replace(/'/g, "''")}'`;
	const args = ['--distribution', name, '--exec', '/bin/sleep', '2147483647'].map(quote).join(',');
	// PowerShell runs on Windows: a configured wslExePath only applies there as-is.
	const exe = process.platform === 'win32' ? wslExePath() : 'C:\\Windows\\System32\\wsl.exe';
	await spawnCapture(
		powershellPath(),
		['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath ${quote(exe)} -WindowStyle Hidden -ArgumentList ${args}`],
		{ cwd: process.platform === 'win32' ? undefined : '/mnt/c' },
	);
}

export function exportDistro(name: string, target: string, vhd: boolean, signal?: AbortSignal) {
	return run(['--export', name, target, ...(vhd ? ['--vhd'] : [])], { signal });
}

export function importDistro(name: string, installDir: string, source: string, vhd: boolean, signal?: AbortSignal) {
	return run(['--import', name, installDir, source, ...(vhd ? ['--vhd'] : [])], { signal });
}

/** Moves the distro's VHDX to another folder; the distro must be stopped. */
export function moveDistro(name: string, location: string, signal?: AbortSignal) {
	return run(['--manage', name, '--move', location], { signal });
}

/**
 * Installs a distro from the online catalog without launching it, so no
 * interactive first-run setup blocks us; that setup (creating the default
 * user) happens the first time a terminal is opened in it.
 */
export function installDistro(distro: string, name: string, location: string | undefined, signal?: AbortSignal) {
	return run(
		['--install', distro, '--name', name, ...(location ? ['--location', location] : []), '--no-launch'],
		{ signal },
	);
}

export interface OnlineDistro {
	name: string;
	friendlyName: string;
}

export async function listOnline(): Promise<OnlineDistro[]> {
	return parseOnlineList((await run(['--list', '--online'])).stdout);
}

/**
 * The intro lines of `--list --online` are localized, but the table header
 * stays "NAME  FRIENDLY NAME". Rows follow it: a name, two or more spaces, and
 * the friendly name.
 */
export function parseOnlineList(stdout: string): OnlineDistro[] {
	const rows = stdout.split(/\r?\n/).map((l) => l.replace(/\0/g, '').trimEnd());
	const header = rows.findIndex((l) => /^NAME\s{2,}FRIENDLY NAME$/.test(l.trim()));
	if (header < 0) {
		return [];
	}
	const distros: OnlineDistro[] = [];
	for (const row of rows.slice(header + 1)) {
		const match = /^(\S+)\s{2,}(\S.*)$/.exec(row.trim());
		if (match) {
			distros.push({ name: match[1], friendlyName: match[2] });
		}
	}
	return distros;
}

export interface RegistryDistro {
	basePath?: string;
	vhdFileName?: string;
	defaultUid?: number;
	flavor?: string;
	osVersion?: string;
}

/**
 * wsl.exe does not expose where a distro is installed or its default UID; that
 * only exists in the registry, one subkey per distro under HKCU\...\Lxss.
 */
export async function registryInfo(): Promise<Map<string, RegistryDistro>> {
	const result = await spawnCapture(
		system32('reg.exe'),
		['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', '/s'],
		{ cwd: process.platform === 'win32' ? undefined : '/mnt/c', tolerateFailure: true },
	);
	return parseRegistry(result.stdout);
}

/** Parses `reg query ...\Lxss /s` output into one entry per distro name. */
export function parseRegistry(stdout: string): Map<string, RegistryDistro> {
	const byName = new Map<string, RegistryDistro>();
	for (const block of stdout.split(/\r?\n\s*\r?\n/)) {
		const values = new Map<string, string>();
		for (const line of block.split(/\r?\n/)) {
			const match = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line);
			if (match) {
				values.set(match[1], match[2].trim());
			}
		}
		const name = values.get('DistributionName');
		if (!name) {
			continue;
		}
		const uid = values.get('DefaultUid');
		byName.set(name, {
			basePath: values.get('BasePath')?.replace(/^\\\\\?\\/, ''),
			vhdFileName: values.get('VhdFileName'),
			defaultUid: uid ? parseInt(uid, 16) : undefined,
			flavor: values.get('Flavor'),
			osVersion: values.get('OsVersion'),
		});
	}
	return byName;
}

/** Converts a Windows path to the host running the extension. */
export async function toHostPath(windowsPath: string): Promise<string> {
	if (process.platform === 'win32') {
		return windowsPath;
	}
	return (await spawnCapture(WSLPATH, ['-u', windowsPath])).stdout.trim();
}

export interface RuntimeInfo {
	prettyName?: string;
	kernel?: string;
	user?: string;
	/** Bytes used on the distro's root filesystem. */
	diskUsed?: number;
	/** Size of the distro's root filesystem, in bytes. */
	diskSize?: number;
}

/**
 * Collects information from inside the distro in a single call. Only use it
 * when the distro is already running: any `wsl -d` boots a stopped distro.
 */
export async function runtimeInfo(name: string): Promise<RuntimeInfo> {
	const script =
		". /etc/os-release 2>/dev/null; echo $PRETTY_NAME; uname -r; id -un; df -Pk / | awk 'NR==2{print $3; print $2}'";
	const result = await run(['--distribution', name, '--exec', '/bin/sh', '-c', script], {
		tolerateFailure: true,
	});
	return parseRuntimeInfo(result.stdout);
}

/** One value per line, in the order the runtimeInfo() script prints them. */
export function parseRuntimeInfo(stdout: string): RuntimeInfo {
	const [prettyName, kernel, user, usedKb, sizeKb] = stdout
		.split(/\r?\n/)
		.map((l) => l.trim() || undefined);
	const kbToBytes = (kb: string | undefined) => {
		const value = Number(kb);
		return kb !== undefined && Number.isFinite(value) ? value * 1024 : undefined;
	};
	return { prettyName, kernel, user, diskUsed: kbToBytes(usedKb), diskSize: kbToBytes(sizeKb) };
}

/**
 * Converts a URI returned by a VS Code file dialog into a path wsl.exe accepts.
 *
 * wsl.exe is a Windows program, so it only understands Windows paths. Dialogs
 * return Linux paths in two cases: when the extension runs on the remote (WSL)
 * host (`file:` URIs of the Linux filesystem), and when it runs on the Windows
 * host but the window is connected to WSL (`vscode-remote://wsl+<distro>/...`).
 */
export async function toWindowsPath(uri: vscode.Uri): Promise<string> {
	if (uri.scheme === 'file') {
		if (process.platform === 'win32') {
			return uri.fsPath;
		}
		return (await spawnCapture(WSLPATH, ['-w', uri.path])).stdout.trim();
	}
	const remote = /^wsl\+(.+)$/i.exec(uri.authority);
	if (uri.scheme === 'vscode-remote' && remote) {
		return linuxToWindowsPath(decodeURIComponent(remote[1]), uri.path);
	}
	throw new Error(vscode.l10n.t('Unsupported location: {0}', uri.toString(true)));
}

/** Same mapping as `wslpath -w`, for a Linux path inside `distro`. */
export function linuxToWindowsPath(distro: string, linuxPath: string): string {
	const drive = /^\/mnt\/([a-z])(\/.*)?$/i.exec(linuxPath);
	if (drive) {
		return `${drive[1].toUpperCase()}:${(drive[2] ?? '/').replace(/\//g, '\\')}`;
	}
	return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`;
}

/** True for paths inside a distro's filesystem (\\wsl.localhost\... or \\wsl$\...). */
export function isInsideDistro(windowsPath: string): boolean {
	return /^\\\\wsl(\.localhost|\$)\\/i.test(windowsPath);
}

/** Folder to open file dialogs in: the Windows user profile, as seen by this host. */
export async function dialogHomeUri(): Promise<vscode.Uri> {
	return vscode.Uri.file(await windowsHomeDir().catch(() => os.homedir()));
}

/**
 * The distro this VS Code window is connected to, if any. On the remote host
 * WSL sets WSL_DISTRO_NAME with the exact name; on the Windows host we fall back
 * to the `wsl+<distro>` authority of the open workspace.
 */
export function currentWindowDistro(): string | undefined {
	if (vscode.env.remoteName !== 'wsl') {
		return undefined;
	}
	if (process.platform !== 'win32' && process.env.WSL_DISTRO_NAME) {
		return process.env.WSL_DISTRO_NAME;
	}
	const uri = vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri;
	const match = uri && /^wsl\+(.+)$/i.exec(uri.authority);
	return match ? decodeURIComponent(match[1]) : undefined;
}

/**
 * The URI authority may come back lowercased, so compare case-insensitively. At
 * worst this warns about an extra distro, which is the safe side to err on.
 */
export function isCurrentWindowDistro(name: string): boolean {
	return currentWindowDistro()?.toLowerCase() === name.toLowerCase();
}

/**
 * Distros created and driven by other tools. Stopping, moving, or
 * unregistering them from here breaks that tool, so the UI labels them and
 * warns before touching them.
 */
const MANAGED_DISTROS: { pattern: RegExp; tool: string; hint: () => string }[] = [
	{ pattern: /^docker-desktop(-data)?$/i, tool: 'Docker Desktop', hint: () => vscode.l10n.t('Use Docker Desktop to stop or reset it.') },
	{ pattern: /^podman-/i, tool: 'Podman', hint: () => vscode.l10n.t('Use `podman machine stop` / `podman machine rm` instead.') },
	{ pattern: /^rancher-desktop(-data)?$/i, tool: 'Rancher Desktop', hint: () => vscode.l10n.t('Use Rancher Desktop to stop or reset it.') },
];

export function managedBy(name: string): { tool: string; hint: string } | undefined {
	const match = MANAGED_DISTROS.find((m) => m.pattern.test(name));
	return match && { tool: match.tool, hint: match.hint() };
}

export interface CompactResult {
	/** diskpart exit code; 0 on success. */
	code: number;
	/** diskpart output, for error messages. */
	log: string;
}

/**
 * The PowerShell script that runs elevated: it pipes the diskpart commands in
 * and writes diskpart's output to `log`. The commands travel inside the
 * elevated process's own command line (-EncodedCommand), never through a file
 * that another program could change between the UAC prompt and the run.
 */
export function diskpartScript(vhd: string, log: string, program = DISKPART): string {
	const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
	const commands = [`select vdisk file="${vhd}"`, 'attach vdisk readonly', 'compact vdisk', 'detach vdisk', 'exit'];
	return (
		`$commands = @(${commands.map(quote).join(', ')}); ` +
		`$commands | & ${program} 2>&1 | Out-File -FilePath ${quote(log)} -Encoding utf8; ` +
		'exit $LASTEXITCODE'
	);
}

/** PowerShell expressions for the programs of the elevated chain, by absolute path. */
const DISKPART = '"$env:SystemRoot\\System32\\diskpart.exe"';
const ELEVATED_POWERSHELL = '"$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"';

/** -EncodedCommand takes the script as base64 of UTF-16LE. */
export function encodePowerShell(script: string): string {
	return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Compacts a dynamic VHDX with diskpart, which needs administrator rights, so
 * Windows shows a UAC prompt. The disk must not be attached: stop the distro
 * first. An elevated process cannot have its output piped back to us, so it
 * writes diskpart's output to a log file that we read afterwards.
 */
export async function compactVhd(vhdWindowsPath: string, program = DISKPART, elevate = true): Promise<CompactResult> {
	const vhd = await asciiPath(vhdWindowsPath);
	const tempHost = await windowsTempDir();
	const tempWindows = await toWindowsHostPath(tempHost);
	const logName = `wsl-distro-manager-${process.pid}-${Date.now()}.log`;
	const logHost = path.join(tempHost, logName);
	const logWindows = path.win32.join(tempWindows, logName);
	const encoded = encodePowerShell(diskpartScript(vhd, logWindows, program));

	try {
		const command =
			`$p = Start-Process -FilePath ${ELEVATED_POWERSHELL} ${elevate ? '-Verb RunAs ' : ''}-Wait -PassThru -WindowStyle Hidden ` +
			`-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; exit $p.ExitCode`;
		const result = await spawnCapture(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', command], {
			cwd: process.platform === 'win32' ? undefined : '/mnt/c',
			tolerateFailure: true,
		});
		const log = await fs.readFile(logHost, 'utf8').then((text) => text.replace(/^\uFEFF/, ''), () => undefined);
		if (log === undefined) {
			// The elevated process never ran: the UAC prompt was declined or failed.
			throw new Error(
				(result.stderr || result.stdout).trim() || vscode.l10n.t('Administrator permission was not granted.'),
			);
		}
		return { code: result.code, log };
	} finally {
		await fs.rm(logHost, { force: true });
	}
}

/**
 * diskpart reads its script in the legacy code page, so an accented path (for
 * example under C:\Users\joão) would reach it garbled. Such paths are replaced
 * by their 8.3 short form (C:\Users\JOO~1\...), which is plain ASCII.
 */
async function asciiPath(windowsPath: string): Promise<string> {
	if (isAscii(windowsPath)) {
		return windowsPath;
	}
	const quoted = windowsPath.replace(/'/g, "''");
	const result = await spawnCapture(
		powershellPath(),
		['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFile('${quoted}').ShortPath`],
		{ cwd: process.platform === 'win32' ? undefined : '/mnt/c', tolerateFailure: true },
	);
	const short = result.stdout.trim();
	if (result.code !== 0 || !short || !isAscii(short)) {
		throw new Error(
			vscode.l10n.t('diskpart cannot open {0}: the path has non-ASCII characters and the drive has no short (8.3) names. Move the distro to a folder with a plain name first.', windowsPath),
		);
	}
	return short;
}

export function isAscii(text: string): boolean {
	return /^[\x00-\x7f]*$/.test(text);
}

function powershellPath(): string {
	return system32('WindowsPowerShell\\v1.0\\powershell.exe');
}

/** Inverse of toHostPath(): a path on this host as Windows sees it. */
async function toWindowsHostPath(hostPath: string): Promise<string> {
	if (process.platform === 'win32') {
		return hostPath;
	}
	return (await spawnCapture(WSLPATH, ['-w', hostPath])).stdout.trim();
}

/**
 * Whether Windows can open the file exclusively. A VHDX stays attached to the
 * WSL VM, and therefore locked, while the VM runs: on current WSL versions even
 * after its own distro stops, as long as any other distro is running.
 */
export async function isFileLocked(windowsPath: string): Promise<boolean> {
	const quoted = windowsPath.replace(/'/g, "''");
	const result = await spawnCapture(
		powershellPath(),
		[
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			`try { $f = [IO.File]::Open('${quoted}', 'Open', 'Read', 'None'); $f.Close(); 'FREE' } catch { 'LOCKED' }`,
		],
		{ cwd: process.platform === 'win32' ? undefined : '/mnt/c', tolerateFailure: true },
	);
	return !result.stdout.includes('FREE');
}

/** Polls until the file is free or the timeout passes; returns whether it got free. */
export async function waitUntilUnlocked(windowsPath: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (!(await isFileLocked(windowsPath))) {
			return true;
		}
		if (Date.now() >= deadline) {
			return false;
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
}

/**
 * Distros that VS Code windows are connected to right now, found through the
 * Windows-side wsl.exe processes that run the VS Code server. Best effort: an
 * empty list when it cannot tell.
 */
export async function vscodeConnectedDistros(): Promise<string[]> {
	const result = await spawnCapture(
		powershellPath(),
		[
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			"Get-CimInstance Win32_Process -Filter \"Name='wsl.exe'\" | ForEach-Object { $_.CommandLine }",
		],
		{ cwd: process.platform === 'win32' ? undefined : '/mnt/c', tolerateFailure: true },
	);
	return parseVscodeConnectedDistros(result.stdout);
}

/** Pure part of vscodeConnectedDistros(): one wsl.exe command line per line. */
export function parseVscodeConnectedDistros(commandLines: string): string[] {
	const distros = new Set<string>();
	for (const line of commandLines.split(/\r?\n/)) {
		if (!/wslServer\.sh|\.vscode-server/.test(line)) {
			continue;
		}
		const match = /\s(?:-d|--distribution)\s+("([^"]+)"|\S+)/.exec(line);
		if (match) {
			distros.add(match[2] ?? match[1]);
		}
	}
	return [...distros];
}

/**
 * The binfmt_misc entry WSL registers so Linux can run Windows .exe files,
 * written exactly as WSL's own systemd override writes it. binfmt_misc belongs
 * to the kernel all distros share, and when a distro stops (Stop, idle
 * timeout) the entry is removed for every other running distro too. WSL
 * already neutralizes systemd-binfmt's --unregister, and the entry still goes,
 * so nothing inside a distro prevents it; it can only be put back.
 */
const INTEROP_REGISTRATION = ':WSLInterop:M::MZ::/init:P';

/** Pure part of interopMissing(): `ls /proc/sys/fs/binfmt_misc` output. */
export function interopMissingFromListing(listing: string): boolean {
	const entries = listing.split(/\s+/).filter(Boolean);
	// Only judge when binfmt_misc is mounted (it always has "register").
	return entries.includes('register') && !entries.some((e) => e.startsWith('WSLInterop'));
}

/**
 * The running distros that lost Windows interop. Runs as the default user:
 * listing binfmt_misc needs no privileges.
 */
export async function interopMissing(distros: string[]): Promise<string[]> {
	const missing: string[] = [];
	for (const distro of distros) {
		const result = await runAsUser(distro, ['ls', '/proc/sys/fs/binfmt_misc']);
		if (result.code === 0 && interopMissingFromListing(result.stdout)) {
			missing.push(distro);
		}
	}
	return missing;
}

export type InteropRepair = 'repaired' | 'password-needed' | 'wrong-password' | 'no-sudo' | 'denied';

/**
 * Re-registers interop through the distro's own `sudo`, so its rules apply
 * (who may use it, whether it needs a password, logging). Never `wsl -u root`,
 * which would bypass them. A default user that is already root writes
 * directly. Without a password, `sudo -n` succeeds only when the distro allows
 * it without one; with a password, it goes to `sudo -S` on standard input,
 * never on the command line, where other processes could read it.
 */
export async function repairInteropWithSudo(distro: string, password?: string): Promise<InteropRepair> {
	const write = `echo '${INTEROP_REGISTRATION}' > /proc/sys/fs/binfmt_misc/register`;
	const script =
		'if [ "$(id -u)" = 0 ]; then sh -c "$1"; exit $?; fi; ' +
		'command -v sudo >/dev/null 2>&1 || exit 127; ' +
		(password === undefined ? 'sudo -n sh -c "$1"' : 'sudo -S -p "" sh -c "$1"');
	const result = await runAsUser(distro, ['sh', '-c', script, 'sh', write], {
		stdin: password === undefined ? undefined : Buffer.from(`${password}\n`, 'utf8'),
	});
	if (result.code === 0) {
		return 'repaired';
	}
	if (result.code === 127) {
		return 'no-sudo';
	}
	if (/not in the sudoers|not allowed to/i.test(result.stderr)) {
		return 'denied';
	}
	return password === undefined ? 'password-needed' : 'wrong-password';
}

/** The command a user can run inside a distro to repair interop by hand. */
export const INTEROP_REPAIR_COMMAND = `sudo sh -c "echo ${INTEROP_REGISTRATION} > /proc/sys/fs/binfmt_misc/register"`;

let cachedDesktop: string | undefined;

/**
 * The real Windows Desktop folder. It is often redirected (for example to
 * OneDrive\Área de Trabalho), so %USERPROFILE%\Desktop is not reliable. Windows
 * PowerShell writes in the legacy code page, which garbles accented folder
 * names, so ask it for UTF-8 output.
 */
export async function windowsDesktopDir(): Promise<string> {
	if (cachedDesktop) {
		return cachedDesktop;
	}
	const result = await spawnCapture(
		powershellPath(),
		['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')"],
		{ cwd: process.platform === 'win32' ? undefined : '/mnt/c' },
	);
	const desktop = result.stdout.trim();
	if (!/^[A-Za-z]:\\/.test(desktop)) {
		throw new Error(vscode.l10n.t('Could not find the Windows Desktop folder.'));
	}
	cachedDesktop = desktop;
	return desktop;
}

/** Runs a program inside the distro as its default user, starting in the home folder. */
export function runAsUser(distro: string, argv: string[], opts: RunOptions = {}): Promise<RunResult> {
	return run(['--distribution', distro, '--cd', '~', '--exec', ...argv], { tolerateFailure: true, ...opts });
}

/** A Windows path as the distro sees it (C:\x -> /mnt/c/x). */
export async function linuxPathInDistro(distro: string, windowsPath: string): Promise<string> {
	const result = await runAsUser(distro, ['wslpath', '-u', windowsPath]);
	const linux = result.stdout.trim();
	if (result.code !== 0 || !linux.startsWith('/')) {
		throw new Error(vscode.l10n.t('Could not translate {0} to a path inside {1}.', windowsPath, distro));
	}
	return linux;
}

export interface HomeEntry {
	name: string;
	isDir: boolean;
}

/** Entries of the default user's home folder, dotfiles included. */
export async function listHome(distro: string): Promise<HomeEntry[]> {
	const result = await runAsUser(distro, ['ls', '-1Ap']);
	return parseHomeListing(result.stdout);
}

/** Pure part of listHome(): `ls -1Ap` marks folders with a trailing slash. */
export function parseHomeListing(stdout: string): HomeEntry[] {
	return stdout
		.split(/\r?\n/)
		.filter((line) => line.length > 0)
		.map((line) => (line.endsWith('/') ? { name: line.slice(0, -1), isDir: true } : { name: line, isDir: false }));
}

export async function hasCommand(distro: string, command: string): Promise<boolean> {
	const result = await runAsUser(distro, ['sh', '-c', 'command -v "$1" >/dev/null', 'sh', command]);
	return result.code === 0;
}

export type FolderAccess = { state: 'ok' | 'denied'; path: string };

/**
 * Resolves a folder inside the distro for the default user (~ and relative
 * paths are from home), creating it if missing, and says whether that user may
 * write there. Nothing runs as root: a folder that needs sudo is 'denied'.
 */
export async function userFolderAccess(distro: string, folder: string): Promise<FolderAccess> {
	const script =
		'd=$1; case "$d" in "~") d=$HOME ;; "~/"*) d="$HOME/${d#??}" ;; /*) ;; *) d="$HOME/$d" ;; esac; ' +
		'if [ -d "$d" ] || mkdir -p -- "$d" 2>/dev/null; then ' +
		'if [ -w "$d" ]; then echo "ok:$d"; else echo "denied:$d"; fi; ' +
		'else echo "denied:$d"; fi';
	const result = await runAsUser(distro, ['sh', '-c', script, 'sh', folder]);
	return parseFolderAccess(result.stdout, folder);
}

export function parseFolderAccess(stdout: string, requested: string): FolderAccess {
	const match = /^(ok|denied):(.*)$/m.exec(stdout.trim());
	return match ? { state: match[1] as 'ok' | 'denied', path: match[2] } : { state: 'denied', path: requested };
}

/** Which of these names already exist in the folder. */
export async function existingNames(distro: string, folder: string, names: string[]): Promise<string[]> {
	const script = 'd=$1; shift; for n in "$@"; do [ -e "$d/$n" ] && printf "%s\\n" "$n"; done; exit 0';
	const result = await runAsUser(distro, ['sh', '-c', script, 'sh', folder, ...names]);
	return result.stdout.split(/\r?\n/).filter(Boolean);
}

export interface WslVersion {
	wsl: string;
	kernel?: string;
}

/**
 * `wsl --version` labels are localized ("Versão do WSL: 2.7.14.0"), but the
 * order is fixed: WSL first, kernel second. Read values by position. Old inbox
 * WSL has no --version and prints usage instead: no ": <digit>" lines.
 */
export function parseWslVersion(stdout: string): WslVersion | undefined {
	const values = stdout
		.split(/\r?\n/)
		.map((line) => /:\s*(\d[\w.+-]*)\s*$/.exec(line.replace(/\0/g, ''))?.[1])
		.filter((v): v is string => v !== undefined);
	return values.length > 0 ? { wsl: values[0], kernel: values[1] } : undefined;
}

let cachedWslVersion: Promise<WslVersion | undefined> | undefined;

/** Cached for the session: it only changes with `wsl --update`. */
export function wslVersion(refresh = false): Promise<WslVersion | undefined> {
	if (refresh || !cachedWslVersion) {
		cachedWslVersion = run(['--version'], { tolerateFailure: true }).then(
			(r) => (r.code === 0 ? parseWslVersion(r.stdout) : undefined),
			() => undefined,
		);
	}
	return cachedWslVersion;
}

export type WslConfig = Record<string, Record<string, string>>;

/**
 * Minimal INI reader for .wslconfig: [sections], key=value, and comments
 * starting with # or ; (whole-line or after a value, which people do write:
 * "memory=8GB  # limit"). Section and key names are lowercased.
 */
export function parseWslConfig(text: string): WslConfig {
	const config: WslConfig = {};
	let section = '';
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/\s[#;].*$/, '').replace(/^\s*[#;].*$/, '').trim();
		if (!line) {
			continue;
		}
		const header = /^\[([^\]]+)\]$/.exec(line);
		if (header) {
			section = header[1].trim().toLowerCase();
			continue;
		}
		const pair = /^([^=]+)=(.*)$/.exec(line);
		if (pair) {
			(config[section] ??= {})[pair[1].trim().toLowerCase()] = pair[2].trim().replace(/^"(.*)"$/, '$1');
		}
	}
	return config;
}

/** The .wslconfig keys worth showing at a glance, in this order. */
const WSLCONFIG_SUMMARY_KEYS: [section: string, key: string, label: string][] = [
	['wsl2', 'memory', 'memory'],
	['wsl2', 'processors', 'processors'],
	['wsl2', 'swap', 'swap'],
	['wsl2', 'networkingmode', 'networkingMode'],
	['wsl2', 'vmidletimeout', 'vmIdleTimeout'],
	['experimental', 'automemoryreclaim', 'autoMemoryReclaim'],
	['experimental', 'sparsevhd', 'sparseVhd'],
];

/** "memory=25GB · processors=8", or undefined when nothing notable is set. */
export function summarizeWslConfig(config: WslConfig): string | undefined {
	const parts = WSLCONFIG_SUMMARY_KEYS.filter(([section, key]) => config[section]?.[key] !== undefined).map(
		([section, key, label]) => `${label}=${config[section][key]}`,
	);
	return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** The global .wslconfig, parsed; an empty config when the file does not exist. */
export async function readWslConfig(): Promise<{ path: string; config: WslConfig; exists: boolean }> {
	const file = path.join(await windowsHomeDir(), '.wslconfig');
	const text = await fs.readFile(file, 'utf8').catch(() => undefined);
	return { path: file, config: text === undefined ? {} : parseWslConfig(text), exists: text !== undefined };
}

/** Seconds since the WSL VM booted, read in a running distro (from /proc/uptime). */
export async function vmUptime(distro: string): Promise<number | undefined> {
	const result = await run(['--distribution', distro, '--exec', 'cat', '/proc/uptime'], { tolerateFailure: true });
	return parseUptime(result.stdout);
}

export function parseUptime(stdout: string): number | undefined {
	const seconds = Number(stdout.trim().split(/\s+/)[0]);
	return stdout.trim() && Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * The distros to start again after WSL shuts down: exactly those that were
 * running, never stopped ones, and not those of Docker, Podman, or Rancher
 * Desktop, which their tools must start (a plain `wsl -d` does not bring
 * their services up).
 */
export function distrosToStartAgain(distros: Distro[]): string[] {
	return distros.filter((d) => d.running && !managedBy(d.name)).map((d) => d.name);
}
