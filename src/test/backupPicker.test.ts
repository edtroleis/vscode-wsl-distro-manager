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
	activeItems: Item[] = [];
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
		if (this.hidden) {
			return;
		}
		this.hidden = true;
		this.emit('hide');
	}
	dispose() {
		this.hide();
	}

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
	accept(activeKey?: string) {
		this.activeItems = this.itemList.filter((i) => i.key === activeKey);
		this.emit('accept');
	}
	hidden = false;
}

const tree: Record<string, { name: string; isDir: boolean }[]> = {
	'.': [{ name: 'code', isDir: true }, { name: 'notes.txt', isDir: false }, { name: '.ssh', isDir: true }],
	code: [{ name: 'app', isDir: true }, { name: 'README.md', isDir: false }],
};
const list = async (_distro: string, folder: string) => tree[folder] ?? [];
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));
const distro = { name: 'Ubuntu', state: 'Running', version: 2, isDefault: false, running: true };

/**
 * The picker opens a new quick pick per folder; `fake` always points at the
 * one on screen, and replaced ones are hidden as VS Code does.
 */
function start() {
	const picks: FakeQuickPick[] = [];
	(window as any).createQuickPick = () => {
		const next = new FakeQuickPick();
		const shown = picks.at(-1);
		next.show = () => {
			if (shown && !shown.hidden) {
				shown.hide();
			}
		};
		picks.push(next);
		return next;
	};
	const result = pickHomePaths(distro, list);
	return {
		get fake() {
			return picks.at(-1)!;
		},
		result,
	};
}

describe('backup picker (asynchronous selection events, as in VS Code)', () => {
	it('keeps a folder checked after clicking it, and backs up all of it without opening it', async () => {
		const picker = start();
		const { result } = picker;
		await settle();
		picker.fake.toggle('code');
		await settle(100);
		assert.deepEqual(picker.fake.checked(), ['code']);
		picker.fake.accept();
		assert.deepEqual((await result)?.paths, ['code']);
	});

	it('keeps single files checked too', async () => {
		const picker = start();
		const { result } = picker;
		await settle();
		picker.fake.toggle('notes.txt');
		await settle(100);
		picker.fake.toggle('code');
		await settle(100);
		assert.deepEqual(picker.fake.checked(), ['code', 'notes.txt']);
		picker.fake.accept();
		assert.deepEqual((await result)?.paths.sort(), ['code', 'notes.txt']);
	});

	it('chooses items inside a folder, and keeps them after going back up', async () => {
		const picker = start();
		const { result } = picker;
		await settle();
		picker.fake.openFolder('code');
		await settle();
		picker.fake.toggle('code/README.md');
		await settle(100);
		assert.deepEqual(picker.fake.checked(), ['code/README.md']);
		picker.fake.accept();
		assert.deepEqual((await result)?.paths, ['code/README.md']);
	});

	it('"Everything" inside a folder unchecks the items chosen there', async () => {
		const picker = start();
		const { result } = picker;
		await settle();
		picker.fake.openFolder('code');
		await settle();
		picker.fake.toggle('code/app');
		await settle(100);
		picker.fake.toggle('code');
		await settle(100);
		assert.deepEqual(picker.fake.checked(), ['code']);
		picker.fake.accept();
		assert.deepEqual((await result)?.paths, ['code']);
	});

	it('unchecking removes it', async () => {
		const picker = start();
		const { result } = picker;
		await settle();
		picker.fake.toggle('code');
		await settle(100);
		picker.fake.toggle('code');
		await settle(100);
		assert.deepEqual(picker.fake.checked(), []);
		picker.fake.hide();
		assert.equal(await result, undefined);
	});

	it('goes back with the Back row, keeping what was chosen inside', async () => {
		const picker = start();
		const { result } = picker;
		await settle();
		picker.fake.openFolder('code');
		await settle();
		picker.fake.toggle('code/README.md');
		await settle(100);
		picker.fake.toggle('\0up');
		await settle();
		assert.ok(picker.fake.items.some((i) => i.key === 'notes.txt'), 'back in home');
		picker.fake.toggle('notes.txt');
		await settle(100);
		picker.fake.accept();
		assert.deepEqual((await result)?.paths.sort(), ['code/README.md', 'notes.txt']);
	});

	it('stays open when accepted with nothing checked, and opens the folder under the cursor', async () => {
		const picker = start();
		const { result } = picker;
		await settle();
		picker.fake.accept('code');
		await settle();
		assert.equal(picker.fake.hidden, false);
		assert.ok(picker.fake.items.some((i) => i.key === 'code/README.md'), 'opened code/');
		picker.fake.accept('code/README.md');
		await settle(100);
		assert.equal(picker.fake.hidden, false);
		assert.match(picker.fake.placeholder, /Nothing selected/);
		picker.fake.toggle('code/README.md');
		await settle(100);
		picker.fake.accept();
		assert.deepEqual((await result)?.paths, ['code/README.md']);
	});
});
