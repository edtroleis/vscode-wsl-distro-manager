import assert = require('node:assert/strict');
import { describe, it } from 'node:test';
import { pickHomePaths } from '../transfer';
import { window } from './vscode.mock';

type Item = { key: string; label: string };

/**
 * Behaves like VS Code's quick pick in the way that broke the picker: selection
 * changes are reported asynchronously, including changes the extension makes
 * itself, and replacing the items first reports an empty selection.
 */
class FakeQuickPick {
	title = '';
	placeholder = '';
	buttons: unknown[] = [];
	busy = false;
	canSelectMany = false;
	ignoreFocusOut = false;
	matchOnDescription = false;
	private itemList: Item[] = [];
	private selection: Item[] = [];
	private listeners: Record<string, ((arg: any) => void)[]> = {};

	private on(name: string) {
		return (listener: (arg: any) => void) => {
			(this.listeners[name] ??= []).push(listener);
			return { dispose: () => undefined };
		};
	}
	private emit(name: string, arg?: unknown) {
		(this.listeners[name] ?? []).forEach((l) => l(arg));
	}
	private report() {
		const snapshot = [...this.selection];
		setTimeout(() => this.emit('selection', snapshot), 5);
	}

	onDidChangeSelection = this.on('selection');
	onDidTriggerItemButton = this.on('itemButton');
	onDidTriggerButton = this.on('button');
	onDidAccept = this.on('accept');
	onDidHide = this.on('hide');

	get items() {
		return this.itemList;
	}
	set items(items: Item[]) {
		this.itemList = items;
		this.selection = [];
		this.report();
	}
	get selectedItems() {
		return this.selection;
	}
	set selectedItems(items: Item[]) {
		this.selection = items;
		this.report();
	}
	show() {}
	hide() {
		this.emit('hide');
	}
	dispose() {}

	/** A user click on a row's checkbox. */
	toggle(key: string) {
		const item = this.itemList.find((i) => i.key === key)!;
		this.selection = this.selection.includes(item) ? this.selection.filter((i) => i !== item) : [...this.selection, item];
		this.report();
	}
	openFolder(key: string) {
		this.emit('itemButton', { item: this.itemList.find((i) => i.key === key) });
	}
	checked() {
		return this.selection.map((i) => i.key).sort();
	}
	accept() {
		this.emit('accept');
	}
}

const tree: Record<string, { name: string; isDir: boolean }[]> = {
	'.': [{ name: 'code', isDir: true }, { name: 'notes.txt', isDir: false }, { name: '.ssh', isDir: true }],
	code: [{ name: 'app', isDir: true }, { name: 'README.md', isDir: false }],
};
const list = async (_distro: string, folder: string) => tree[folder] ?? [];
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));
const distro = { name: 'Ubuntu', state: 'Running', version: 2, isDefault: false, running: true };

function start() {
	const fake = new FakeQuickPick();
	(window as any).createQuickPick = () => fake;
	const result = pickHomePaths(distro, list);
	return { fake, result };
}

describe('backup picker (asynchronous selection events, as in VS Code)', () => {
	it('keeps a folder checked after clicking it, and backs up all of it without opening it', async () => {
		const { fake, result } = start();
		await settle();
		fake.toggle('code');
		await settle(100);
		assert.deepEqual(fake.checked(), ['code']);
		fake.accept();
		assert.deepEqual((await result)?.paths, ['code']);
	});

	it('keeps single files checked too', async () => {
		const { fake, result } = start();
		await settle();
		fake.toggle('notes.txt');
		await settle(100);
		fake.toggle('code');
		await settle(100);
		assert.deepEqual(fake.checked(), ['code', 'notes.txt']);
		fake.accept();
		assert.deepEqual((await result)?.paths.sort(), ['code', 'notes.txt']);
	});

	it('chooses items inside a folder, and keeps them after going back up', async () => {
		const { fake, result } = start();
		await settle();
		fake.openFolder('code');
		await settle();
		fake.toggle('code/README.md');
		await settle(100);
		assert.deepEqual(fake.checked(), ['code/README.md']);
		fake.accept();
		assert.deepEqual((await result)?.paths, ['code/README.md']);
	});

	it('"Everything" inside a folder unchecks the items chosen there', async () => {
		const { fake, result } = start();
		await settle();
		fake.openFolder('code');
		await settle();
		fake.toggle('code/app');
		await settle(100);
		fake.toggle('code');
		await settle(100);
		assert.deepEqual(fake.checked(), ['code']);
		fake.accept();
		assert.deepEqual((await result)?.paths, ['code']);
	});

	it('unchecking removes it', async () => {
		const { fake, result } = start();
		await settle();
		fake.toggle('code');
		await settle(100);
		fake.toggle('code');
		await settle(100);
		assert.deepEqual(fake.checked(), []);
		fake.accept();
		assert.deepEqual((await result)?.paths, []);
	});
});
