import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { windowsHomeDir } from './wsl';

export const SCHEME = 'wsl-config';

const WSLCONFIG_TEMPLATE = `# .wslconfig - global settings for the WSL 2 VM (applies to every distro).
# Applied when WSL restarts (every distro stops); Windows does not need to restart.
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

/** Resolved on demand because it depends on which host runs the extension. */
async function globalConfigPath(): Promise<string> {
	return path.join(await windowsHomeDir(), '.wslconfig');
}

/** The only file this provider serves: the global .wslconfig on Windows. */
export function globalUri(): vscode.Uri {
	return vscode.Uri.from({ scheme: SCHEME, path: '/global/.wslconfig' });
}

function assertGlobal(uri: vscode.Uri): void {
	if (uri.path !== globalUri().path) {
		throw vscode.FileSystemError.FileNotFound(uri);
	}
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
		assertGlobal(uri);
		// A missing file opens with a commented template; saving is what creates it.
		const content =
			(await fs.readFile(await globalConfigPath(), 'utf8').catch(() => undefined)) ?? WSLCONFIG_TEMPLATE;

		const key = uri.toString();
		const cached = this.versions.get(key);
		if (!cached || cached.content !== content) {
			this.versions.set(key, { content, mtime: Date.now() });
		}
		return Buffer.from(content, 'utf8');
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
		assertGlobal(uri);
		const buffer = Buffer.from(content);
		await fs.writeFile(await globalConfigPath(), buffer);

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
