import * as vscode from 'vscode';
import { SCHEME, WslConfigFileSystem, describe, targetDistro } from './configFs';
import { confirmRestartIfCurrentWindow, registerCommands } from './commands';
import { DistroTreeProvider } from './tree';
import * as wsl from './wsl';

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
 * Neither wsl.conf nor .wslconfig take effect immediately: the first requires
 * rebooting the distro, the second shutting down the WSL VM. We offer the right
 * action on save.
 */
async function onConfigSaved(document: vscode.TextDocument): Promise<void> {
	if (document.uri.scheme !== SCHEME) {
		return;
	}
	const distro = targetDistro(document.uri);

	if (distro) {
		const choice = await vscode.window.showInformationMessage(
			vscode.l10n.t('{0} saved. Restart "{1}" to apply it?', describe(document.uri), distro),
			vscode.l10n.t('Restart Distro'),
		);
		if (choice && (await confirmRestartIfCurrentWindow(distro))) {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Restarting {0}...', distro) },
				async () => {
					await wsl.terminate(distro);
					await wsl.start(distro);
				},
			);
			await vscode.commands.executeCommand('wslManager.refresh');
		}
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
