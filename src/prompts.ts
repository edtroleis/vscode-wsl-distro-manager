import * as vscode from 'vscode';

export interface TextPromptOptions {
	title: string;
	prompt?: string;
	value?: string;
	placeHolder?: string;
	validateInput?: (value: string) => string | undefined;
}

interface ConfirmItem extends vscode.QuickPickItem {
	valid: boolean;
}

/**
 * A text prompt with a visible, clickable Confirm button.
 *
 * showInputBox confirms only with Enter, and an input box accepts buttons only
 * as small icons in its title bar, which did not read as a button. A quick
 * pick keeps the text field and shows a "✓ Confirm" row right under it, with
 * the typed value and the explanation, that a click confirms. Enter and the ✓
 * in the title bar confirm too. When the value is invalid, the row shows why
 * and confirms nothing. The prompt stays open when focus moves away.
 */
export function promptText(options: TextPromptOptions): Promise<string | undefined> {
	return new Promise((resolve) => {
		const pick = vscode.window.createQuickPick<ConfirmItem>();
		pick.title = options.title;
		pick.placeholder = options.placeHolder;
		pick.value = options.value ?? '';
		pick.ignoreFocusOut = true;
		// The row must stay visible whatever is typed, so do not filter it by the text.
		pick.matchOnDescription = false;
		pick.matchOnDetail = false;
		const confirm: vscode.QuickInputButton = {
			iconPath: new vscode.ThemeIcon('check'),
			tooltip: vscode.l10n.t('Confirm'),
		};
		pick.buttons = [confirm];

		const refresh = () => {
			const error = options.validateInput?.(pick.value);
			const item: ConfirmItem = error
				? { label: `$(error) ${error}`, alwaysShow: true, valid: false }
				: {
						label: `$(check) ${vscode.l10n.t('Confirm')}`,
						description: pick.value,
						detail: options.prompt,
						alwaysShow: true,
						valid: true,
					};
			pick.items = [item];
			pick.activeItems = [item];
		};

		let accepted = false;
		const accept = () => {
			if (options.validateInput?.(pick.value)) {
				refresh();
				return;
			}
			accepted = true;
			resolve(pick.value);
			pick.hide();
		};
		pick.onDidChangeValue(refresh);
		pick.onDidAccept(accept);
		pick.onDidTriggerButton((button) => {
			if (button === confirm) {
				accept();
			}
		});
		pick.onDidHide(() => {
			if (!accepted) {
				resolve(undefined);
			}
			pick.dispose();
		});
		refresh();
		pick.show();
	});
}

/**
 * A masked password prompt, confirmed with Enter or the ✓ in its title bar.
 * The value is returned to the caller only; nothing stores or logs it.
 */
export function promptPassword(title: string, prompt: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const box = vscode.window.createInputBox();
		box.title = title;
		box.prompt = prompt;
		box.password = true;
		box.ignoreFocusOut = true;
		const confirm: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('check'), tooltip: vscode.l10n.t('Confirm') };
		box.buttons = [confirm];
		let accepted = false;
		const accept = () => {
			accepted = true;
			resolve(box.value);
			box.hide();
		};
		box.onDidAccept(accept);
		box.onDidTriggerButton((button) => button === confirm && accept());
		box.onDidHide(() => {
			if (!accepted) {
				resolve(undefined);
			}
			box.dispose();
		});
		box.show();
	});
}
