import assert = require('node:assert/strict');
import { describe, it } from 'node:test';
import { GlobalItem, wslConfigItem, wslVersionItem } from '../tree';
import { decode, parseWslConfig, parseWslVersion, summarizeWslConfig } from '../wsl';

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
