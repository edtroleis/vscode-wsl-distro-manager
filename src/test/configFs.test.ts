import assert = require('node:assert/strict');
import { describe, it } from 'node:test';
import { SCHEME, describe as describeUri, distroUri, globalUri, targetDistro } from '../configFs';
import { Uri } from './vscode.mock';

describe('config URIs', () => {
	it('builds the global .wslconfig URI', () => {
		const uri = globalUri();
		assert.equal(uri.scheme, SCHEME);
		assert.equal(targetDistro(uri), undefined);
		assert.equal(describeUri(uri), '.wslconfig');
	});

	it('round-trips a distro wsl.conf URI', () => {
		const uri = distroUri('Ubuntu-24.04');
		assert.equal(targetDistro(uri), 'Ubuntu-24.04');
		assert.equal(describeUri(uri), 'Ubuntu-24.04: /etc/wsl.conf');
	});

	it('keeps the distro name case, which the URI authority would lose', () => {
		assert.equal(targetDistro(distroUri('FedoraLinux-43')), 'FedoraLinux-43');
		assert.equal(distroUri('FedoraLinux-43').authority, '');
	});

	it('rejects paths it does not know', () => {
		const bogus = Uri.from({ scheme: SCHEME, path: '/elsewhere/file' });
		assert.throws(() => targetDistro(bogus as never), /FileNotFound/);
	});
});
