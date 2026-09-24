import assert = require('node:assert/strict');
import { describe, it } from 'node:test';
import { SCHEME, WslConfigFileSystem, globalUri } from '../configFs';
import { Uri } from './vscode.mock';

describe('wsl-config file system', () => {
	it('serves the global .wslconfig', () => {
		const uri = globalUri();
		assert.equal(uri.scheme, SCHEME);
		assert.equal(uri.path, '/global/.wslconfig');
	});

	it('serves nothing else: distro files such as /etc/wsl.conf are not reachable', async () => {
		const fsProvider = new WslConfigFileSystem();
		const wslConf = Uri.from({ scheme: SCHEME, path: '/distro/Ubuntu/etc/wsl.conf' });
		await assert.rejects(fsProvider.readFile(wslConf as never), /FileNotFound/);
		await assert.rejects(fsProvider.writeFile(wslConf as never, new Uint8Array()), /FileNotFound/);
	});
});
