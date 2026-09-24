import assert = require('node:assert/strict');
import { describe, it } from 'node:test';
import { GlobalItem, wslConfigItem, wslVersionItem } from '../tree';
import { decode, distrosToStartAgain, parseUptime, parseWslVersion } from '../wsl';
import { restartedSince } from '../pending';

describe('parseWslVersion', () => {
	it('reads a localized `wsl --version` by position (real Portuguese output, UTF-16)', () => {
		const output = Buffer.from(
			'Versão do WSL: 2.7.14.0\r\nVersão do kernel: 6.18.33.2-2\r\nVersão do WSLg: 1.0.73.2\r\nVersão do Windows: 10.0.26200.9550\r\n',
			'utf16le',
		);
		assert.deepEqual(parseWslVersion(decode(output)), { wsl: '2.7.14.0', kernel: '6.18.33.2-2' });
	});

	it('reads the English output too', () => {
		assert.deepEqual(parseWslVersion('WSL version: 2.4.13.0\nKernel version: 5.15.167.4-1\n'), {
			wsl: '2.4.13.0',
			kernel: '5.15.167.4-1',
		});
	});

	it('returns undefined for old WSL, which prints usage instead', () => {
		assert.equal(parseWslVersion('Usage: wsl.exe [Argument] [Options...] [CommandLine]\n'), undefined);
	});
});

describe('WSL node', () => {
	it('is expanded unless the user collapsed it, with a stable id', () => {
		assert.equal(new GlobalItem(true).collapsibleState, 2);
		assert.equal(new GlobalItem(false).collapsibleState, 1);
		assert.equal(new GlobalItem(true).id, 'global');
	});

	it('is named after the file, shows nothing from inside it, and opens it on click', () => {
		const item = wslConfigItem(true, 'C:\\Users\\u\\.wslconfig');
		assert.equal(item.label, '.wslconfig');
		assert.equal(item.description, undefined);
		assert.doesNotMatch(String(item.tooltip), /=/);
		assert.equal(item.command?.command, 'wslManager.editWslConfig');
	});

	it('says when .wslconfig does not exist', () => {
		assert.equal(wslConfigItem(false, 'x').description, 'not created');
	});

	it('shows the WSL and kernel versions, or how to get them', () => {
		assert.equal(wslVersionItem({ wsl: '2.7.14.0', kernel: '6.18.33.2-2' }).description, 'WSL 2.7.14.0 · kernel 6.18.33.2-2');
		assert.equal(wslVersionItem(undefined).description, 'unknown (run "wsl --update")');
	});
});

describe('pending .wslconfig changes', () => {
	it('flags the row, says WSL (not Windows) must restart, and offers the restart inline', () => {
		const item = wslConfigItem(true, 'C:\\Users\\u\\.wslconfig', true);
		assert.equal(item.description, 'restart WSL to apply');
		assert.equal(item.contextValue, 'wslGlobalConfig.pending');
		assert.match(String(item.tooltip), /restart WSL \(not Windows\)/);
	});

	it('is a plain settings row when nothing is pending', () => {
		const item = wslConfigItem(true, 'x');
		assert.equal(item.contextValue, 'wslGlobalConfig');
		assert.match(String(item.tooltip), /Windows does not need to restart/);
	});
});

describe('restartedSince', () => {
	const savedAt = Date.UTC(2026, 8, 24, 12, 0, 0);

	it('is true when the VM booted after the save', () => {
		const now = savedAt + 60_000;
		assert.equal(restartedSince(savedAt, 30, now), true); // booted 30 s after the save
	});

	it('is false when the VM was already up before the save', () => {
		const now = savedAt + 60_000;
		assert.equal(restartedSince(savedAt, 3600, now), false);
	});

	it('does not depend on the VM clock, only on how long it has been up', () => {
		// The VM clock drifted ~10 s from Windows in testing; uptime is relative, so no clock is compared.
		assert.equal(restartedSince(savedAt, 59.5, savedAt + 60_000), false);
		assert.equal(restartedSince(savedAt, 58, savedAt + 60_000), true);
	});
});

describe('parseUptime', () => {
	it('reads the first number of /proc/uptime', () => {
		assert.equal(parseUptime('12345.67 98765.43\n'), 12345.67);
	});

	it('returns undefined for empty or odd output', () => {
		assert.equal(parseUptime(''), undefined);
		assert.equal(parseUptime('cat: /proc/uptime: No such file'), undefined);
	});
});

describe('distrosToStartAgain', () => {
	const d = (name: string, running: boolean) => ({ name, running, state: running ? 'Running' : 'Stopped', version: 2, isDefault: false });

	it('starts again exactly the distros that were running', () => {
		const distros = [d('fedora-linux-43', true), d('Ubuntu-24.04', false), d('FedoraLinux-43', true)];
		assert.deepEqual(distrosToStartAgain(distros), ['fedora-linux-43', 'FedoraLinux-43']);
	});

	it('never starts a stopped distro', () => {
		assert.deepEqual(distrosToStartAgain([d('Ubuntu-24.04', false), d('Debian', false)]), []);
	});

	it('leaves Docker, Podman, and Rancher distros to their tools, even when running', () => {
		const distros = [d('podman-machine-default', true), d('docker-desktop', true), d('Ubuntu-24.04', true)];
		assert.deepEqual(distrosToStartAgain(distros), ['Ubuntu-24.04']);
	});
});
