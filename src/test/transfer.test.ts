import assert = require('node:assert/strict');
import { describe, it } from 'node:test';
import {
	backupCommand,
	backupFileName,
	backupOutcome,
	childPath,
	extractCommand,
	isArchive,
	isCloudSynced,
	isWithin,
	normalizeSelection,
	parseExcludes,
	parseTypedPaths,
	sensitivePaths,
	updateSelection,
} from '../transfer';
import { parseFolderAccess, parseHomeListing } from '../wsl';

describe('backupFileName', () => {
	it('stamps distro, date, and time, and sorts chronologically', () => {
		const name = backupFileName('fedora-linux-43', new Date(2026, 8, 3, 7, 5, 9), 'tar.gz');
		assert.equal(name, 'fedora-linux-43-backup-20260903-070509.tar.gz');
	});

	it('keeps the name valid on Windows', () => {
		assert.equal(backupFileName('a:b', new Date(2026, 0, 1), 'zip'), 'a_b-backup-20260101-000000.zip');
	});
});

describe('parseExcludes', () => {
	it('accepts commas and spaces, and drops duplicates', () => {
		assert.deepEqual(parseExcludes('node_modules, .venv  target,node_modules'), ['node_modules', '.venv', 'target']);
	});

	it('returns nothing for an empty answer', () => {
		assert.deepEqual(parseExcludes('  '), []);
	});
});

describe('backupCommand', () => {
	it('builds tar with excludes before the paths, and -- so paths are never options', () => {
		assert.deepEqual(backupCommand('tar.gz', '/mnt/c/out.tar.gz', ['code', '-weird'], ['node_modules']), [
			'tar', '-czf', '/mnt/c/out.tar.gz', '--exclude=node_modules', '--', 'code', '-weird',
		]);
	});

	it('builds zip that stores symlinks as links and excludes at any depth', () => {
		assert.deepEqual(backupCommand('zip', '/mnt/c/out.zip', ['code', '-weird'], ['.venv']), [
			'zip', '-r', '-q', '-y', '/mnt/c/out.zip', 'code', './-weird', '-x', '.venv', '.venv/*', '*/.venv', '*/.venv/*',
		]);
	});

	it('omits -x when nothing is excluded', () => {
		assert.ok(!backupCommand('zip', 'o.zip', ['a'], []).includes('-x'));
	});
});

describe('backupOutcome', () => {
	it('treats partial archives as warnings, not failures', () => {
		assert.equal(backupOutcome('tar.gz', 0), 'ok');
		assert.equal(backupOutcome('tar.gz', 1), 'warnings'); // file changed while read
		assert.equal(backupOutcome('tar.gz', 2), 'warnings'); // some files unreadable
		assert.equal(backupOutcome('zip', 18), 'warnings');
		assert.equal(backupOutcome('zip', 12), 'failed'); // nothing to do
		assert.equal(backupOutcome('tar.gz', 127), 'failed'); // tar missing
	});
});

describe('archives', () => {
	it('recognizes backups to offer extraction', () => {
		assert.equal(isArchive('x-backup.TAR.GZ'), 'tar.gz');
		assert.equal(isArchive('x.tgz'), 'tar.gz');
		assert.equal(isArchive('x.zip'), 'zip');
		assert.equal(isArchive('notes.txt'), undefined);
	});

	it('extracts into the chosen folder', () => {
		assert.deepEqual(extractCommand('tar.gz', '/h/b.tar.gz', '/h'), ['tar', '-xzf', '/h/b.tar.gz', '-C', '/h']);
		assert.deepEqual(extractCommand('zip', '/h/b.zip', '/h'), ['unzip', '-o', '-q', '/h/b.zip', '-d', '/h']);
	});
});

describe('parseHomeListing', () => {
	it('splits folders (trailing slash) from files, dotfiles included', () => {
		assert.deepEqual(parseHomeListing('.bashrc\n.config/\ncode/\nnotes.txt\n'), [
			{ name: '.bashrc', isDir: false },
			{ name: '.config', isDir: true },
			{ name: 'code', isDir: true },
			{ name: 'notes.txt', isDir: false },
		]);
	});
});

describe('parseFolderAccess', () => {
	it('reads the resolved folder and whether the user may write there', () => {
		assert.deepEqual(parseFolderAccess('ok:/home/u/Downloads\n', '~/Downloads'), { state: 'ok', path: '/home/u/Downloads' });
		assert.deepEqual(parseFolderAccess('denied:/root', '/root'), { state: 'denied', path: '/root' });
	});

	it('denies when the distro gave no answer', () => {
		assert.deepEqual(parseFolderAccess('', '/x'), { state: 'denied', path: '/x' });
	});
});

describe('sensitivePaths', () => {
	it('flags folders that usually hold credentials, also nested or absolute', () => {
		assert.deepEqual(sensitivePaths(['code', '.ssh', 'projects/app/.aws', '/root/.kube/config', '.config/gcloud', 'notes.txt']), [
			'.ssh',
			'projects/app/.aws',
			'/root/.kube/config',
			'.config/gcloud',
		]);
	});

	it('does not flag look-alikes', () => {
		assert.deepEqual(sensitivePaths(['ssh-notes', '.sshrc-backup', 'aws-scripts', '.config']), []);
	});
});

describe('isCloudSynced', () => {
	it('recognizes folders that cloud clients upload', () => {
		assert.equal(isCloudSynced('C:\\Users\\u\\OneDrive\\Área de Trabalho'), true);
		assert.equal(isCloudSynced('C:\\Users\\u\\OneDrive - Contoso\\Desktop'), true);
		assert.equal(isCloudSynced('C:\\Users\\u\\Dropbox'), true);
	});

	it('does not flag local folders', () => {
		assert.equal(isCloudSynced('C:\\Users\\u\\Desktop'), false);
		assert.equal(isCloudSynced('D:\\Backups\\OneDriveOld'), false);
	});
});

describe('folder selection', () => {
	// The view of ~/code: the folder itself ("Everything in code/") and its entries.
	const view = ['code', 'code/app', 'code/lib', 'code/notes.md'];

	it('builds paths relative to home', () => {
		assert.equal(childPath('.', 'code'), 'code');
		assert.equal(childPath('code', 'app'), 'code/app');
	});

	it('knows what a folder contains', () => {
		assert.equal(isWithin('code/app', 'code'), true);
		assert.equal(isWithin('code', 'code'), true);
		assert.equal(isWithin('codes', 'code'), false);
		assert.equal(isWithin('anything', '.'), true);
	});

	it('drops paths already covered by a chosen folder', () => {
		assert.deepEqual(normalizeSelection(['code', 'code/app', 'docs', 'docs']), ['code', 'docs']);
		assert.deepEqual(normalizeSelection(['.', 'code']), ['.']);
	});

	it('takes the whole folder when "Everything" is checked, replacing items chosen inside', () => {
		const before = ['docs', 'code/app', 'code/lib/src'];
		assert.deepEqual(updateSelection(before, 'code', view, ['code/app'], ['code/app', 'code']), ['docs', 'code']);
	});

	it('takes only the chosen items inside a folder', () => {
		assert.deepEqual(updateSelection(['docs'], 'code', view, [], ['code/app', 'code/notes.md']), ['docs', 'code/app', 'code/notes.md']);
	});

	it('switches from "Everything" to items when an item is checked', () => {
		assert.deepEqual(updateSelection(['code'], 'code', view, ['code'], ['code', 'code/lib']), ['code/lib']);
	});

	it('keeps choices made deeper in the folder when entries change', () => {
		assert.deepEqual(updateSelection(['code/app/src'], 'code', view, [], ['code/notes.md']), ['code/app/src', 'code/notes.md']);
	});

	it('removes what is unchecked', () => {
		assert.deepEqual(updateSelection(['code/app', 'code/lib'], 'code', view, ['code/app', 'code/lib'], ['code/lib']), ['code/lib']);
	});
});

describe('sensitivePaths with the whole home folder', () => {
	it('names the credential folders the home folder would take along', () => {
		assert.deepEqual(sensitivePaths(['.'], ['.bashrc', '.ssh', 'code', '.aws']), ['~/.ssh', '~/.aws']);
	});

	it('says nothing when the home folder has none', () => {
		assert.deepEqual(sensitivePaths(['.'], ['.bashrc', 'code']), []);
	});
});

describe('parseTypedPaths', () => {
	it('turns ~ into paths relative to home, since no shell expands it', () => {
		assert.deepEqual(parseTypedPaths(' ~/.ssh, projects/app ,/etc/nginx, ~ ,'), ['.ssh', 'projects/app', '/etc/nginx', '.']);
	});
});
