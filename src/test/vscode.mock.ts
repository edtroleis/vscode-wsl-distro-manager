/**
 * Minimal stand-in for the `vscode` module, which only exists inside the
 * extension host. It covers just what the modules under test touch at load
 * time and in the functions exercised by the unit tests.
 */

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

export class TreeItem {
	[key: string]: unknown;
	constructor(
		public label: string,
		public collapsibleState?: number,
	) {}
}

export class ThemeIcon {
	constructor(
		public id: string,
		public color?: unknown,
	) {}
}

export class ThemeColor {
	constructor(public id: string) {}
}

export class MarkdownString {
	value = '';
	appendMarkdown(text: string): this {
		this.value += text;
		return this;
	}
}

export class EventEmitter<T> {
	private listeners: ((value: T) => void)[] = [];
	event = (listener: (value: T) => void) => {
		this.listeners.push(listener);
		return new Disposable(() => undefined);
	};
	fire(value: T): void {
		this.listeners.forEach((l) => l(value));
	}
	dispose(): void {
		this.listeners = [];
	}
}

export class Disposable {
	constructor(private readonly callback: () => void) {}
	static from(...items: { dispose(): unknown }[]): Disposable {
		return new Disposable(() => items.forEach((i) => i.dispose()));
	}
	dispose(): void {
		this.callback();
	}
}

export class Uri {
	private constructor(
		readonly scheme: string,
		readonly authority: string,
		readonly path: string,
	) {}
	get fsPath(): string {
		return this.path;
	}
	static from(c: { scheme: string; authority?: string; path?: string }): Uri {
		return new Uri(c.scheme, c.authority ?? '', c.path ?? '');
	}
	static file(path: string): Uri {
		return new Uri('file', '', path);
	}
	static joinPath(base: Uri, ...segments: string[]): Uri {
		return new Uri(base.scheme, base.authority, [base.path, ...segments].join('/').replace(/\/+/g, '/'));
	}
	toString(): string {
		return `${this.scheme}://${this.authority}${this.path}`;
	}
}

export const FileSystemError = {
	FileNotFound: (uri?: unknown) => new Error(`FileNotFound: ${String(uri)}`),
	NoPermissions: (message?: string) => new Error(`NoPermissions: ${message}`),
};

/** Settings returned by workspace.getConfiguration(); tests assign keys directly. */
export const settings: Record<string, unknown> = {};

export const workspace = {
	workspaceFolders: undefined as { uri: Uri }[] | undefined,
	workspaceFile: undefined as Uri | undefined,
	getConfiguration: () => ({
		get: <T>(key: string, defaultValue?: T): T | undefined =>
			key in settings ? (settings[key] as T) : defaultValue,
	}),
};

export const env = {
	remoteName: undefined as string | undefined,
};

/** English passthrough of vscode.l10n: fills {0}-style placeholders. */
export const l10n = {
	t: (message: string, ...args: unknown[]): string =>
		message.replace(/\{(\d+)\}/g, (match, index) => (Number(index) < args.length ? String(args[Number(index)]) : match)),
};

const noop = () => undefined;
export const window = {
	createOutputChannel: () => ({ trace: noop, debug: noop, info: noop, warn: noop, error: noop, appendLine: noop, dispose: noop }),
};
export const commands = {};
