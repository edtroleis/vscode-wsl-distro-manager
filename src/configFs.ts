import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { readFileAsRoot, windowsHomeDir, writeFileAsRoot } from './wsl';

export const SCHEME = 'wsl-config';

const WSL_CONF_TEMPLATE = `# /etc/wsl.conf - settings for this distribution.
# Applied on the next boot of the distro (use "Restart" in the WSL Distro Manager view).
# Docs: https://learn.microsoft.com/windows/wsl/wsl-config

[boot]
systemd=true
# command =

[automount]
enabled=true
options="metadata,umask=22,fmask=11"
# mountFsTab=true

[network]
generateHosts=true
generateResolvConf=true
# hostname =

[interop]
enabled=true
appendWindowsPath=true

# [user]
# default=your-user
`;

const WSLCONFIG_TEMPLATE = `# .wslconfig - global settings for the WSL 2 VM (applies to every distro).
# Applied after "wsl --shutdown".
# Docs: https://learn.microsoft.com/windows/wsl/wsl-config

[wsl2]
# memory=8GB
# processors=4
# swap=0
# localhostForwarding=true
# nestedVirtualization=true
# networkingMode=mirrored
# dnsTunneling=true
# firewall=true

# [experimental]
# autoMemoryReclaim=gradual
# sparseVhd=true
`;

type Target = { kind: 'global' } | { kind: 'distro'; distro: string; file: string };

/** Resolved on demand because it depends on which host runs the extension. */
async function globalConfigPath(): Promise<string> {
	return path.join(await windowsHomeDir(), '.wslconfig');
}

export function globalUri(): vscode.Uri {
	return vscode.Uri.from({ scheme: SCHEME, path: '/global/.wslconfig' });
}

export function distroUri(distro: string): vscode.Uri {
	return vscode.Uri.from({ scheme: SCHEME, path: `/distro/${distro}/etc/wsl.conf` });
}

/**
 * The distro name goes in the path (not the authority) because VS Code lowercases
 * the authority, and names like "FedoraLinux-43" need their exact case.
 */
function parse(uri: vscode.Uri): Target {
	const segments = uri.path.split('/').filter(Boolean);
	if (segments[0] === 'global') {
		return { kind: 'global' };
	}
	if (segments[0] === 'distro' && segments.length >= 2) {
		return { kind: 'distro', distro: segments[1], file: '/' + segments.slice(2).join('/') };
	}
	throw vscode.FileSystemError.FileNotFound(uri);
}

export function describe(uri: vscode.Uri): string {
	const target = parse(uri);
	return target.kind === 'global' ? '.wslconfig' : `${target.distro}: ${target.file}`;
}

export function targetDistro(uri: vscode.Uri): string | undefined {
	const target = parse(uri);
	return target.kind === 'distro' ? target.distro : undefined;
}

export class WslConfigFileSystem implements vscode.FileSystemProvider {
	private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.emitter.event;

	/**
	 * mtime must stay stable while the content is unchanged, otherwise VS Code
	 * thinks the file changed outside the editor and shows the conflict dialog.
	 */
	private readonly versions = new Map<string, { content: string; mtime: number }>();

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => undefined);
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const data = await this.readFile(uri);
		const cached = this.versions.get(uri.toString());
		return {
			type: vscode.FileType.File,
			ctime: 0,
			mtime: cached?.mtime ?? Date.now(),
			size: data.byteLength,
		};
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const target = parse(uri);
		let content: string | undefined;

		if (target.kind === 'global') {
			content = await fs.readFile(await globalConfigPath(), 'utf8').catch(() => undefined);
		} else {
			content = await readFileAsRoot(target.distro, target.file);
		}

		// A missing file opens with a commented template; saving is what creates it.
		if (content === undefined) {
			content = target.kind === 'global' ? WSLCONFIG_TEMPLATE : WSL_CONF_TEMPLATE;
		}

		const key = uri.toString();
		const cached = this.versions.get(key);
		if (!cached || cached.content !== content) {
			this.versions.set(key, { content, mtime: Date.now() });
		}
		return Buffer.from(content, 'utf8');
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
		const target = parse(uri);
		const buffer = Buffer.from(content);

		if (target.kind === 'global') {
			await fs.writeFile(await globalConfigPath(), buffer);
		} else {
			// wsl.conf needs LF; the editor may have saved CRLF on a Windows host.
			const normalized = Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
			await writeFileAsRoot(target.distro, target.file, normalized);
		}

		this.versions.set(uri.toString(), { content: buffer.toString('utf8'), mtime: Date.now() });
		this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
	}

	readDirectory(): [string, vscode.FileType][] {
		throw vscode.FileSystemError.NoPermissions('Only individual files are supported.');
	}
	createDirectory(): void {
		throw vscode.FileSystemError.NoPermissions('Only individual files are supported.');
	}
	delete(): void {
		throw vscode.FileSystemError.NoPermissions('Deleting is not supported.');
	}
	rename(): void {
		throw vscode.FileSystemError.NoPermissions('Renaming is not supported.');
	}
}
