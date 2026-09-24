import assert = require('node:assert/strict');
import { describe, it } from 'node:test';
import { GlobalItem, wslConfigItem, wslVersionItem } from '../tree';
import { decode, parseUptime, parseWslConfig, parseWslVersion, summarizeWslConfig } from '../wsl';
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

describe('parseWslConfig', () => {
	it('reads sections and keys, ignoring comments, even after a value', () => {
		const config = parseWslConfig(
			'# global settings\n[wsl2]\nmemory=25GB   # Limits VM memory\nprocessors=8  ; two cores\n\n[Experimental]\nsparseVhd = true\n',
		);
		assert.deepEqual(config, { wsl2: { memory: '25GB', processors: '8' }, experimental: { sparsevhd: 'true' } });
	});

	it('lowercases names, unquotes values, and keeps "=" inside values', () => {
		assert.deepEqual(parseWslConfig('[WSL2]\nKernelCommandLine = "a=b c"\n'), { wsl2: { kernelcommandline: 'a=b c' } });
	});

	it('returns an empty config for an empty or commented-out file', () => {
		assert.deepEqual(parseWslConfig('# [wsl2]\n# memory=8GB\n'), {});
	});
});

describe('summarizeWslConfig', () => {
	it('lists the notable keys in a fixed order, with their usual spelling', () => {
		const config = parseWslConfig('[experimental]\nautoMemoryReclaim=gradual\n[wsl2]\nprocessors=8\nmemory=25GB\nnetworkingMode=mirrored\n');
		assert.equal(summarizeWslConfig(config), 'memory=25GB · processors=8 · networkingMode=mirrored · autoMemoryReclaim=gradual');
	});

	it('returns undefined when nothing notable is set', () => {
		assert.equal(summarizeWslConfig(parseWslConfig('[wsl2]\nguiApplications=false\n')), undefined);
		assert.equal(summarizeWslConfig({}), undefined);
	});
});

describe('WSL node', () => {
	it('is expanded unless the user collapsed it, with a stable id', () => {
		assert.equal(new GlobalItem(true).collapsibleState, 2);
		assert.equal(new GlobalItem(false).collapsibleState, 1);
		assert.equal(new GlobalItem(true).id, 'global');
	});

	it('shows the .wslconfig summary and opens the file on click', () => {
		const item = wslConfigItem('memory=25GB · processors=8', true, 'C:\\Users\\u\\.wslconfig');
		assert.equal(item.description, 'memory=25GB · processors=8');
		assert.equal(item.command?.command, 'wslManager.editWslConfig');
	});

	it('says when .wslconfig does not exist or sets nothing', () => {
		assert.equal(wslConfigItem(undefined, false, 'x').description, 'not created; WSL defaults');
		assert.equal(wslConfigItem(undefined, true, 'x').description, 'WSL defaults');
	});

	it('shows the WSL and kernel versions, or how to get them', () => {
		assert.equal(wslVersionItem({ wsl: '2.7.14.0', kernel: '6.18.33.2-2' }).description, 'WSL 2.7.14.0 · kernel 6.18.33.2-2');
		assert.equal(wslVersionItem(undefined).description, 'unknown (run "wsl --update")');
	});
});

describe('pending .wslconfig changes', () => {
	it('flags the row, says WSL (not Windows) must restart, and offers the restart inline', () => {
		const item = wslConfigItem('memory=25GB', true, 'C:\\Users\\u\\.wslconfig', true);
		assert.equal(item.description, 'restart WSL to apply · memory=25GB');
		assert.equal(item.contextValue, 'wslGlobalConfig.pending');
		assert.match(String(item.tooltip), /restart WSL \(not Windows\)/);
	});

	it('is a plain settings row when nothing is pending', () => {
		const item = wslConfigItem('memory=25GB', true, 'x');
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
