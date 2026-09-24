import * as vscode from 'vscode';
import { SCHEME, WslConfigFileSystem } from './configFs';
import { registerCommands } from './commands';
import { DistroTreeProvider } from './tree';

export function activate(context: vscode.ExtensionContext): void {
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
 * .wslconfig does not take effect until the WSL VM restarts, so offer that on
 * save. Only the global .wslconfig is served by the wsl-config: scheme.
 */
async function onConfigSaved(document: vscode.TextDocument): Promise<void> {
	if (document.uri.scheme !== SCHEME) {
		return;
	}
	// The WSL node summarizes .wslconfig: show the new values right away.
	void vscode.commands.executeCommand('wslManager.refresh');
	const choice = await vscode.window.showInformationMessage(
		vscode.l10n.t('.wslconfig saved. Run "wsl --shutdown" to apply it?'),
		vscode.l10n.t('Shut Down WSL'),
	);
	if (choice) {
		await vscode.commands.executeCommand('wslManager.shutdown');
	}
}

export function deactivate(): void {
	// Everything is released through context.subscriptions.
}
