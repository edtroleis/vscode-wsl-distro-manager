import assert = require('node:assert/strict');
import { describe, it } from 'node:test';
import * as fs from 'fs';
import * as path from 'path';

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
const settings: Record<string, { scope?: string }> = manifest.contributes.configuration.properties;

describe('package.json', () => {
	it('lets no workspace choose programs, users, destinations, or confirmations', () => {
		// The extension runs in untrusted workspaces too. A cloned repository's
		// .vscode/settings.json must not point wslExePath at its own .exe, open
		// terminals as root, redirect backups, or turn confirmations off.
		for (const key of ['wslExePath', 'defaultUser', 'backupFolder', 'confirmDestructiveActions']) {
			assert.equal(settings[`wslManager.${key}`]?.scope, 'machine', key);
		}
	});
});
