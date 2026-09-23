import { ChildProcess, spawn } from 'child_process';
import * as os from 'os';
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

export function wslExePath(): string {
	const configured = vscode.workspace.getConfiguration('wslManager').get<string>('wslExePath');
	if (configured) {
		return configured;
	}
	// Even with extensionKind "ui" the host can be Linux when the window is
	// connected to a distro; in that case we call wsl.exe through interop.
	if (process.platform !== 'win32') {
		return '/mnt/c/Windows/System32/wsl.exe';
	}
	return 'wsl.exe';
}

export interface RunOptions {
	stdin?: Buffer;
	/** Do not reject the promise when the process exits with a non-zero code. */
	tolerateFailure?: boolean;
}

export interface RunResult {
	stdout: string;
	stderr: string;
	code: number;
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
		child.on('close', (code) => {
			const result: RunResult = {
				stdout: decode(Buffer.concat(out)),
				stderr: decode(Buffer.concat(err)),
				code: code ?? -1,
			};
			if (result.code === 0 || opts.tolerateFailure) {
				resolve(result);
			} else {
				const message = (result.stderr || result.stdout).trim();
				reject(new Error(message || `${command} exited with code ${result.code}`));
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

let cachedWindowsHome: string | undefined;

/**
 * The %USERPROFILE% folder as seen by the current host.
 *
 * When the extension runs on the remote (Linux) host, os.homedir() would return
 * /home/<user>, which is not where .wslconfig lives. In that case we ask Windows
 * and translate with wslpath. The /mnt/c cwd avoids the UNC path warning that
 * cmd.exe prints when invoked from inside the Linux filesystem.
 */
export async function windowsHomeDir(): Promise<string> {
	if (process.platform === 'win32') {
		return os.homedir();
	}
	if (cachedWindowsHome) {
		return cachedWindowsHome;
	}
	const profile = await spawnCapture(
		'/mnt/c/Windows/System32/cmd.exe',
		['/c', 'echo %USERPROFILE%'],
		{ cwd: '/mnt/c' },
	);
	const windowsPath = profile.stdout.trim();
	if (!windowsPath || windowsPath.includes('%USERPROFILE%')) {
		throw new Error('Could not determine the Windows %USERPROFILE%.');
	}
	const translated = await spawnCapture('wslpath', ['-u', windowsPath]);
	cachedWindowsHome = translated.stdout.trim();
	return cachedWindowsHome;
}

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
	const names = lines((await run(['--list', '--quiet'])).stdout);
	if (names.length === 0) {
		return [];
	}

	// With no running distros, wsl.exe exits non-zero with an informational message.
	const runningResult = await run(['--list', '--running', '--quiet'], { tolerateFailure: true });
	const runningNames = new Set(runningResult.code === 0 ? lines(runningResult.stdout) : []);

	const verbose = await run(['--list', '--verbose'], { tolerateFailure: true });
	const verboseLines = lines(verbose.stdout).slice(1);

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
export const setVersion = (name: string, version: 1 | 2) =>
	run(['--set-version', name, String(version)]);
export const shutdown = () => run(['--shutdown']);
export const unregister = (name: string) => run(['--unregister', name]);

/** Runs `true` inside the distro, which is enough for WSL to boot it. */
export const start = (name: string) => run(['--distribution', name, '--exec', '/bin/true']);

export function exportDistro(name: string, target: string, vhd: boolean) {
	return run(['--export', name, target, ...(vhd ? ['--vhd'] : [])]);
}

export function importDistro(name: string, installDir: string, source: string, vhd: boolean) {
	return run(['--import', name, installDir, source, ...(vhd ? ['--vhd'] : [])]);
}

/**
 * Reads a file inside the distro as root. Going through `wsl --exec` instead of
 * the \\wsl.localhost share avoids "permission denied" under /etc, since the
 * share accesses the distro as the default user. The path is passed as a shell
 * argument ($1) so it is never reinterpreted.
 */
export async function readFileAsRoot(distro: string, path: string): Promise<string | undefined> {
	const result = await run(
		['--distribution', distro, '--user', 'root', '--exec', '/bin/sh', '-c', 'cat "$1"', 'sh', path],
		{ tolerateFailure: true },
	);
	return result.code === 0 ? result.stdout : undefined;
}

/** Writes a file inside the distro as root, preserving /etc permissions. */
export async function writeFileAsRoot(distro: string, path: string, content: Buffer): Promise<void> {
	await run(
		['--distribution', distro, '--user', 'root', '--exec', '/bin/sh', '-c', 'cat > "$1"', 'sh', path],
		{ stdin: content },
	);
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
	const regExe = process.platform === 'win32' ? 'reg.exe' : '/mnt/c/Windows/System32/reg.exe';
	const result = await spawnCapture(
		regExe,
		['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', '/s'],
		{ cwd: process.platform === 'win32' ? undefined : '/mnt/c', tolerateFailure: true },
	);
	const byName = new Map<string, RegistryDistro>();
	for (const block of result.stdout.split(/\r?\n\s*\r?\n/)) {
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
	return (await spawnCapture('wslpath', ['-u', windowsPath])).stdout.trim();
}

export interface RuntimeInfo {
	prettyName?: string;
	kernel?: string;
	user?: string;
	diskUsed?: string;
	diskSize?: string;
}

/**
 * Collects information from inside the distro in a single call. Only use it
 * when the distro is already running: any `wsl -d` boots a stopped distro.
 */
export async function runtimeInfo(name: string): Promise<RuntimeInfo> {
	const script =
		". /etc/os-release 2>/dev/null; echo $PRETTY_NAME; uname -r; id -un; df -Ph / | awk 'NR==2{print $3; print $2}'";
	const result = await run(['--distribution', name, '--exec', '/bin/sh', '-c', script], {
		tolerateFailure: true,
	});
	const [prettyName, kernel, user, diskUsed, diskSize] = result.stdout
		.split(/\r?\n/)
		.map((l) => l.trim() || undefined);
	return { prettyName, kernel, user, diskUsed, diskSize };
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
		return (await spawnCapture('wslpath', ['-w', uri.path])).stdout.trim();
	}
	const remote = /^wsl\+(.+)$/i.exec(uri.authority);
	if (uri.scheme === 'vscode-remote' && remote) {
		const drive = /^\/mnt\/([a-z])(\/.*)?$/i.exec(uri.path);
		if (drive) {
			return `${drive[1].toUpperCase()}:${(drive[2] ?? '/').replace(/\//g, '\\')}`;
		}
		return `\\\\wsl.localhost\\${decodeURIComponent(remote[1])}${uri.path.replace(/\//g, '\\')}`;
	}
	throw new Error(`Unsupported location: ${uri.toString(true)}`);
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
