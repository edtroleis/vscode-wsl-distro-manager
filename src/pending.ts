import * as vscode from 'vscode';

/**
 * .wslconfig changes apply only when the WSL VM restarts. After a save, the
 * WSL node flags the setting as pending until the extension sees a VM that
 * booted after the save, or restarts WSL itself. Kept in globalState so a
 * window reload does not lose it.
 */
const KEY = 'wslconfigSavedAt';
let state: vscode.Memento | undefined;

export function initPending(context: vscode.ExtensionContext): void {
	state = context.globalState;
}

export function pendingSince(): number | undefined {
	return state?.get<number>(KEY);
}

export function markPending(at = Date.now()): Thenable<void> | undefined {
	return state?.update(KEY, at);
}

export function clearPending(): Thenable<void> | undefined {
	return state?.update(KEY, undefined);
}

/**
 * Whether the VM running now booted after the save. `uptimeSeconds` comes from
 * /proc/uptime, a relative time, so the drift between the VM clock and Windows
 * does not matter. A small margin absorbs the time it took to read it.
 */
export function restartedSince(savedAt: number, uptimeSeconds: number, now = Date.now()): boolean {
	const bootedAt = now - uptimeSeconds * 1000;
	return bootedAt > savedAt + 1000;
}
