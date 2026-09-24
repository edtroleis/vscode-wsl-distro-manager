import * as vscode from 'vscode';
import { promptPassword } from './prompts';
import * as wsl from './wsl';

let noticeOpen = false;

/**
 * WSL removes Windows interop from every running distro when one stops. The
 * extension only detects it (no privileges needed) and asks; the repair runs
 * through the distro's sudo, and only after the user agrees.
 */
export async function offerInteropRepair(running?: string[]): Promise<void> {
	if (noticeOpen) {
		return;
	}
	const names = running ?? (await wsl.list()).filter((d) => d.running).map((d) => d.name);
	// WSL removes the entry a few seconds after the distro stops, not at once:
	// look again for a while (as the default user, so it is cheap and harmless).
	let missing: string[] = [];
	for (let waited = 0; waited <= 15 && missing.length === 0; waited += 5) {
		if (waited > 0) {
			await new Promise((r) => setTimeout(r, 5000));
		}
		missing = await wsl.interopMissing(names).catch(() => []);
	}
	if (missing.length === 0 || noticeOpen) {
		return;
	}
	noticeOpen = true;
	try {
		const repair = vscode.l10n.t('Repair...');
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t(
				'WSL removed Windows interop from {0}: .exe files no longer run there. Repair it? It uses sudo in the distro.',
				missing.join(', '),
			),
			repair,
		);
		if (choice === repair) {
			await vscode.commands.executeCommand('wslManager.repairInterop');
		}
	} finally {
		noticeOpen = false;
	}
}

/** The Repair Windows Interop command: confirm, then sudo, asking for a password only if the distro wants one. */
export async function repairInterop(): Promise<void> {
	const running = (await wsl.list()).filter((d) => d.running).map((d) => d.name);
	const missing = await wsl.interopMissing(running);
	if (missing.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t('Windows interop is working in every running distro.'));
		return;
	}
	// binfmt_misc is shared by every distro: repairing it in one repairs all.
	// Prefer a distro of your own over a Docker/Podman one.
	const candidates = missing.filter((name) => !wsl.managedBy(name));
	const choices = candidates.length > 0 ? candidates : missing;
	const target =
		choices.length === 1
			? choices[0]
			: (
					await vscode.window.showQuickPick(choices, {
						title: vscode.l10n.t('Repair Windows interop'),
						placeHolder: vscode.l10n.t('Use sudo in which distro? Repairing it in one repairs all.'),
					})
				);
	if (!target) {
		return;
	}
	const confirm = vscode.l10n.t('Repair');
	const ok = await vscode.window.showWarningMessage(
		vscode.l10n.t('Repair Windows interop with sudo in "{0}"?', target),
		{
			modal: true,
			detail: vscode.l10n.t(
				'This runs one command as root through the distro\'s sudo, so its rules apply:\n\n{0}\n\nIf sudo asks for a password, you will be prompted for it. It is sent to sudo only and never stored.',
				wsl.INTEROP_REPAIR_COMMAND,
			),
		},
		confirm,
	);
	if (ok !== confirm) {
		return;
	}

	let outcome = await wsl.repairInteropWithSudo(target);
	for (let attempt = 1; attempt <= 3 && (outcome === 'password-needed' || outcome === 'wrong-password'); attempt++) {
		const password = await promptPassword(
			vscode.l10n.t('sudo password in "{0}"', target),
			outcome === 'wrong-password'
				? vscode.l10n.t('Wrong password, try again. It is sent to sudo only and never stored.')
				: vscode.l10n.t('Your password in the distro. It is sent to sudo only and never stored.'),
		);
		if (password === undefined) {
			return;
		}
		outcome = await wsl.repairInteropWithSudo(target, password);
	}

	switch (outcome) {
		case 'repaired': {
			const still = await wsl.interopMissing(running).catch(() => []);
			vscode.window.showInformationMessage(
				still.length === 0
					? vscode.l10n.t('Windows interop repaired in {0}.', missing.join(', '))
					: vscode.l10n.t('Windows interop repaired in "{0}", but {1} still lack it.', target, still.join(', ')),
			);
			return;
		}
		case 'no-sudo':
			throw new Error(vscode.l10n.t('"{0}" has no sudo. Run this as root inside the distro instead: {1}', target, wsl.INTEROP_REPAIR_COMMAND));
		case 'denied':
			throw new Error(vscode.l10n.t('Your user may not use sudo in "{0}". Ask an administrator of the distro, or run as root: {1}', target, wsl.INTEROP_REPAIR_COMMAND));
		default:
			throw new Error(vscode.l10n.t('sudo did not accept the password for "{0}". Nothing was changed.', target));
	}
}
