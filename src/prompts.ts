import * as vscode from 'vscode';

export interface TextPromptOptions {
	title: string;
	prompt?: string;
	value?: string;
	placeHolder?: string;
	validateInput?: (value: string) => string | undefined;
}

/**
 * Like vscode.window.showInputBox, plus a ✓ button in the title bar, so the
 * answer can be confirmed with the mouse and not only with Enter. The box stays
 * open when focus moves away, and an invalid value can be confirmed by neither.
 */
export function promptText(options: TextPromptOptions): Promise<string | undefined> {
	return new Promise((resolve) => {
		const box = vscode.window.createInputBox();
		box.title = options.title;
		box.prompt = options.prompt;
		box.value = options.value ?? '';
		box.placeholder = options.placeHolder;
		box.ignoreFocusOut = true;
		const confirm: vscode.QuickInputButton = {
			iconPath: new vscode.ThemeIcon('check'),
			tooltip: vscode.l10n.t('Confirm'),
		};
		box.buttons = [confirm];

		let accepted = false;
		const validate = () => {
			box.validationMessage = options.validateInput?.(box.value);
			return !box.validationMessage;
		};
		const accept = () => {
			if (validate()) {
				accepted = true;
				resolve(box.value);
				box.hide();
			}
		};
		box.onDidChangeValue(() => validate());
		box.onDidAccept(accept);
		box.onDidTriggerButton((button) => {
			if (button === confirm) {
				accept();
			}
		});
		box.onDidHide(() => {
			if (!accepted) {
				resolve(undefined);
			}
			box.dispose();
		});
		box.show();
	});
}
