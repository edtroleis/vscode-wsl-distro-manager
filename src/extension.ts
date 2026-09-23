import * as vscode from 'vscode';
import { SCHEME, WslConfigFileSystem, describe, targetDistro } from './configFs';
import { registerCommands } from './commands';
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
			view.badge = running > 0 ? { value: running, tooltip: `${running} running` } : undefined;
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
			`${describe(document.uri)} saved. Restart "${distro}" to apply it?`,
			'Restart Distro',
		);
		if (choice) {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Restarting ${distro}...` },
				async () => {
					await wsl.terminate(distro);
					await wsl.start(distro);
				},
			);
			await vscode.commands.executeCommand('wslManager.refresh');
		}
		return;
	}

	const choice = await vscode.window.showInformationMessage(
		'.wslconfig saved. Run "wsl --shutdown" to apply it?',
		'Shut Down WSL',
	);
	if (choice) {
		await vscode.commands.executeCommand('wslManager.shutdown');
	}
}

export function deactivate(): void {
	// Everything is released through context.subscriptions.
}
