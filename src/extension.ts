import * as vscode from 'vscode';
import { SCHEME, WslConfigFileSystem } from './configFs';
import { registerCommands } from './commands';
import { initPending, markPending } from './pending';
import { DistroTreeProvider } from './tree';

export function activate(context: vscode.ExtensionContext): void {
	initPending(context);
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider(SCHEME, new WslConfigFileSystem(), {
			isCaseSensitive: true,
		}),
	);

	const tree = new DistroTreeProvider();
	const view = vscode.window.createTreeView('wslManager.distros', {
		treeDataProvider: tree,
		showCollapseAll: false,
	});
	context.subscriptions.push(view, tree.bindVisibility(view));

	context.subscriptions.push(
		tree.onDidLoad((distros) => {
			const running = distros.filter((d) => d.running).length;
			view.badge = running > 0 ? { value: running, tooltip: vscode.l10n.t('{0} running', running) } : undefined;
		}),
	);

	registerCommands(context, tree);
	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(onConfigSaved));
}

/**
 * .wslconfig takes effect only when the WSL VM restarts, not Windows. Say so on
 * save, offer the restart, and flag the change as pending in the WSL node
 * until it is applied. Only the global .wslconfig is served by wsl-config:.
 */
async function onConfigSaved(document: vscode.TextDocument): Promise<void> {
	if (document.uri.scheme !== SCHEME) {
		return;
	}
	await markPending();
	void vscode.commands.executeCommand('wslManager.refresh');
	const restart = vscode.l10n.t('Restart WSL Now');
	const choice = await vscode.window.showWarningMessage(
		vscode.l10n.t(
			'.wslconfig saved. The changes take effect only after WSL restarts (every distro stops and starts again). Windows does not need to restart.',
		),
		restart,
	);
	if (choice === restart) {
		await vscode.commands.executeCommand('wslManager.restartWsl');
	}
}

export function deactivate(): void {
	// Everything is released through context.subscriptions.
}
