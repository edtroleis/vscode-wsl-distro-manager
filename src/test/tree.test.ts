import assert = require('node:assert/strict');
import { describe, it } from 'node:test';
import { DistroItem, vhdxItem } from '../tree';
import { Distro } from '../wsl';

const GB = 1024 ** 3;

function distro(overrides: Partial<Distro> = {}): Distro {
	return { name: 'Ubuntu', state: 'Running', version: 2, isDefault: false, running: true, ...overrides };
}

describe('DistroItem', () => {
	it('encodes state in contextValue for the menus', () => {
		assert.equal(new DistroItem(distro()).contextValue, 'wslDistro.running');
		assert.equal(new DistroItem(distro({ running: false })).contextValue, 'wslDistro.stopped');
	});

	it('marks and labels distros managed by another tool', () => {
		const item = new DistroItem(distro({ name: 'podman-machine-default', running: false }));
		assert.equal(item.contextValue, 'wslDistro.stopped.managed');
		assert.match(String(item.description), /^Podman · /);
	});

	it('puts the default marker first among the badges', () => {
		assert.equal(new DistroItem(distro({ isDefault: true })).description, 'default · WSL 2 · Running');
	});

	it('keeps its id across refreshes while the state is unchanged', () => {
		assert.equal(new DistroItem(distro()).id, new DistroItem(distro()).id);
	});

	it('changes its id with the state, so VS Code redraws the icon color', () => {
		assert.notEqual(new DistroItem(distro()).id, new DistroItem(distro({ running: false })).id);
	});

	it('colors the icon green only while running', () => {
		const color = (d: Distro) => (new DistroItem(d).iconPath as { color?: { id: string } }).color?.id;
		assert.equal(color(distro()), 'charts.green');
		assert.equal(color(distro({ running: false })), undefined);
	});

	it('restores expansion given by the provider', () => {
		assert.equal(new DistroItem(distro(), true).collapsibleState, 2);
		assert.equal(new DistroItem(distro()).collapsibleState, 1);
	});
});

describe('vhdxItem', () => {
	const vhd = 'E:\\wsl\\Ubuntu\\ext4.vhdx';

	it('shows reclaimable space once it passes 1 GB', () => {
		const item = vhdxItem(new DistroItem(distro()), vhd, 79 * GB, 66 * GB);
		assert.equal(item.description, '79.0 GB · ~13.0 GB reclaimable');
		assert.equal(item.contextValue, 'wslVhdx');
	});

	it('shows only the size when the gap is small', () => {
		const item = vhdxItem(new DistroItem(distro()), vhd, 10 * GB, 9.5 * GB);
		assert.equal(item.description, '10.0 GB');
	});

	it('cannot estimate for a stopped distro, but still offers compaction', () => {
		const item = vhdxItem(new DistroItem(distro({ running: false })), vhd, 20 * GB, undefined);
		assert.equal(item.description, '20.0 GB');
		assert.match(String(item.tooltip), /Start the distro/);
		assert.equal(item.contextValue, 'wslVhdx');
	});

	it('offers no compaction for managed distros', () => {
		const item = vhdxItem(new DistroItem(distro({ name: 'docker-desktop' })), vhd, 50 * GB, 1 * GB);
		assert.equal(item.contextValue, 'wslInfo');
	});

	it('links back to its distro for the inline Compact action', () => {
		const parent = new DistroItem(distro());
		assert.equal(vhdxItem(parent, vhd, GB, GB).parent, parent);
	});
});
