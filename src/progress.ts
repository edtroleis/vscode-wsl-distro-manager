import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { formatBytes } from './monitor';
import { CancelledError } from './wsl';

export function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title, cancellable: false },
		task,
	);
}

export function formatElapsed(ms: number): string {
	const seconds = Math.round(ms / 1000);
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Cancellable progress for a wsl.exe operation that writes one growing file
 * (export, import, move, backup). Resolves to undefined when the user cancels.
 */
export async function withFileProgress<T>(
	title: string,
	file: string,
	expectedSize: number | undefined,
	task: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title, cancellable: true },
		async (progress, token) => {
			const controller = new AbortController();
			token.onCancellationRequested(() => controller.abort());
			const started = Date.now();
			let reported = 0;
			const timer = setInterval(() => {
				void fs.stat(file).then(
					(st) => {
						const written = vscode.l10n.t('{0} written, {1}', formatBytes(st.size), formatElapsed(Date.now() - started));
						if (expectedSize) {
							const percent = Math.min(99, Math.floor((st.size / expectedSize) * 100));
							progress.report({ increment: Math.max(0, percent - reported), message: `~${percent}% · ${written}` });
							reported = Math.max(reported, percent);
						} else {
							progress.report({ message: written });
						}
					},
					() => progress.report({ message: vscode.l10n.t('starting, {0}', formatElapsed(Date.now() - started)) }),
				);
			}, 1000);
			try {
				return await task(controller.signal);
			} catch (error) {
				if (error instanceof CancelledError) {
					return undefined;
				}
				throw error;
			} finally {
				clearInterval(timer);
			}
		},
	);
}
