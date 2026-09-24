import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

/**
 * The extension's log, in the Output panel ("Distro Manager for WSL"). Only
 * events and decisions go here, never passwords or file contents.
 */
export function log(): vscode.LogOutputChannel {
	channel ??= vscode.window.createOutputChannel('Distro Manager for WSL', { log: true });
	return channel;
}
