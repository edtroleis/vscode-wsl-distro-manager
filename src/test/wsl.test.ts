import assert = require('node:assert/strict');
import { afterEach, describe, it } from 'node:test';
import {
	currentWindowDistro,
	decode,
	isCurrentWindowDistro,
	isInsideDistro,
	linuxToWindowsPath,
	parseDistroList,
	parseRegistry,
	parseRuntimeInfo,
	toWindowsPath,
} from '../wsl';
import { Uri, env, workspace } from './vscode.mock';

/** wsl.exe output as it arrives on stdout: UTF-16LE, CRLF, no BOM. */
function utf16(text: string): Buffer {
	return Buffer.from(text.replace(/\n/g, '\r\n'), 'utf16le');
}

describe('decode', () => {
	it('decodes UTF-16LE without a BOM (what wsl.exe actually writes)', () => {
		assert.equal(decode(utf16('  NAME   STATE\n')), '  NAME   STATE\r\n');
	});

	it('decodes UTF-16LE with a BOM and drops the BOM', () => {
		const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ubuntu', 'utf16le')]);
		assert.equal(decode(withBom), 'Ubuntu');
	});

	it('keeps UTF-8 as UTF-8, including non-ASCII text', () => {
		assert.equal(decode(Buffer.from('Em execução\n', 'utf8')), 'Em execução\n');
	});

	it('handles empty and very short buffers', () => {
		assert.equal(decode(Buffer.alloc(0)), '');
		assert.equal(decode(Buffer.from('a', 'utf8')), 'a');
	});
});

describe('parseDistroList', () => {
	const quiet = decode(utf16('fedora-linux-43\nUbuntu-24.04\nFedoraLinux-43\n'));

	it('combines names, running state, default marker, and version', () => {
		const verbose = decode(
			utf16(
				'  NAME               STATE           VERSION\n' +
					'* fedora-linux-43    Running         2\n' +
					'  Ubuntu-24.04       Stopped         2\n' +
					'  FedoraLinux-43     Stopped         1\n',
			),
		);
		const running = decode(utf16('fedora-linux-43\n'));

		assert.deepEqual(parseDistroList(quiet, running, verbose), [
			{ name: 'fedora-linux-43', state: 'Running', version: 2, isDefault: true, running: true },
			{ name: 'Ubuntu-24.04', state: 'Stopped', version: 2, isDefault: false, running: false },
			{ name: 'FedoraLinux-43', state: 'Stopped', version: 1, isDefault: false, running: false },
		]);
	});

	it('ignores the localized STATE column, even when it contains spaces', () => {
		const verbose =
			'  NOME               ESTADO          VERSÃO\n' +
			'* fedora-linux-43    Em execução     2\n' +
			'  Ubuntu-24.04       Parado          1\n';
		const distros = parseDistroList(quiet, 'fedora-linux-43\n', verbose);

		assert.equal(distros[0].running, true);
		assert.equal(distros[0].state, 'Running');
		assert.equal(distros[1].version, 1);
		assert.equal(distros[1].running, false);
	});

	it('treats every distro as stopped when nothing is running', () => {
		const distros = parseDistroList(quiet, '', '');
		assert.ok(distros.every((d) => !d.running && d.state === 'Stopped'));
	});

	it('does not match a distro against another whose name starts the same', () => {
		const verbose =
			'  NAME            STATE      VERSION\n' +
			'  Ubuntu-24.04    Stopped    1\n' +
			'* Ubuntu          Running    2\n';
		const [ubuntu, ubuntu24] = parseDistroList('Ubuntu\nUbuntu-24.04\n', 'Ubuntu\n', verbose);

		assert.deepEqual([ubuntu.version, ubuntu.isDefault], [2, true]);
		assert.deepEqual([ubuntu24.version, ubuntu24.isDefault], [1, false]);
	});

	it('keeps names that differ only in case apart', () => {
		const verbose =
			'  NAME               STATE      VERSION\n' +
			'  FedoraLinux-43     Stopped    1\n' +
			'* fedora-linux-43    Running    2\n';
		const distros = parseDistroList('FedoraLinux-43\nfedora-linux-43\n', 'fedora-linux-43\n', verbose);

		assert.deepEqual(
			distros.map((d) => [d.name, d.version, d.running]),
			[
				['FedoraLinux-43', 1, false],
				['fedora-linux-43', 2, true],
			],
		);
	});

	it('defaults to WSL 2 and not-default when the verbose row is missing', () => {
		const [distro] = parseDistroList('Orphan\n', '', '  NAME  STATE  VERSION\n');
		assert.equal(distro.version, 2);
		assert.equal(distro.isDefault, false);
	});

	it('strips stray NUL characters and blank lines', () => {
		const names = parseDistroList('Ubuntu\0\r\n\r\n\0Debian\r\n', '', '').map((d) => d.name);
		assert.deepEqual(names, ['Ubuntu', 'Debian']);
	});

	it('returns an empty list when there are no distros', () => {
		assert.deepEqual(parseDistroList('', '', ''), []);
	});
});

describe('parseRegistry', () => {
	const output = [
		'',
		'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss',
		'    DefaultVersion    REG_DWORD    0x2',
		'    DefaultDistribution    REG_SZ    {01057ee0-e3e1-4df9-855c-145ddf186f20}',
		'',
		'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{01057ee0-e3e1-4df9-855c-145ddf186f20}',
		'    State    REG_DWORD    0x1',
		'    DistributionName    REG_SZ    fedora-linux-43',
		'    BasePath    REG_SZ    E:\\wsl\\fedora-linux-43\\',
		'    DefaultUid    REG_DWORD    0x0',
		'    VhdFileName    REG_SZ    ext4.vhdx',
		'    Flavor    REG_SZ    fedora',
		'    OsVersion    REG_SZ    43',
		'',
		'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{ce4a5618-818b-4426-9c3e-9183cc172025}',
		'    DistributionName    REG_SZ    Ubuntu-24.04',
		'    BasePath    REG_SZ    \\\\?\\C:\\Users\\user\\AppData\\Local\\wsl\\{ce4a5618}',
		'    DefaultUid    REG_DWORD    0x3e8',
		'    VhdFileName    REG_SZ    ext4.vhdx',
		'',
	].join('\r\n');

	it('returns one entry per distro and skips the root key', () => {
		const registry = parseRegistry(output);
		assert.deepEqual([...registry.keys()], ['fedora-linux-43', 'Ubuntu-24.04']);
	});

	it('reads paths, flavor, and version', () => {
		assert.deepEqual(parseRegistry(output).get('fedora-linux-43'), {
			basePath: 'E:\\wsl\\fedora-linux-43\\',
			vhdFileName: 'ext4.vhdx',
			defaultUid: 0,
			flavor: 'fedora',
			osVersion: '43',
		});
	});

	it('parses hex DWORDs and strips the \\\\?\\ long-path prefix', () => {
		const ubuntu = parseRegistry(output).get('Ubuntu-24.04');
		assert.equal(ubuntu?.defaultUid, 1000);
		assert.equal(ubuntu?.basePath, 'C:\\Users\\user\\AppData\\Local\\wsl\\{ce4a5618}');
		assert.equal(ubuntu?.flavor, undefined);
	});

	it('returns an empty map for empty or failed output', () => {
		assert.equal(parseRegistry('').size, 0);
		assert.equal(parseRegistry('ERROR: The system was unable to find the specified registry key.').size, 0);
	});
});

describe('parseRuntimeInfo', () => {
	it('maps each line to its field', () => {
		const info = parseRuntimeInfo('Fedora Linux 43 (WSL)\n6.18.33.2-microsoft-standard-WSL2\nuser\n66G\n1007G\n');
		assert.deepEqual(info, {
			prettyName: 'Fedora Linux 43 (WSL)',
			kernel: '6.18.33.2-microsoft-standard-WSL2',
			user: 'user',
			diskUsed: '66G',
			diskSize: '1007G',
		});
	});

	it('leaves missing or blank values undefined', () => {
		const info = parseRuntimeInfo('\r\n6.6.0\r\nroot\r\n');
		assert.equal(info.prettyName, undefined);
		assert.equal(info.kernel, '6.6.0');
		assert.equal(info.diskSize, undefined);
	});
});

describe('linuxToWindowsPath', () => {
	it('maps /mnt/<drive> to the Windows drive', () => {
		assert.equal(linuxToWindowsPath('Ubuntu', '/mnt/c/Users/user/a.tar'), 'C:\\Users\\user\\a.tar');
		assert.equal(linuxToWindowsPath('Ubuntu', '/mnt/e/wsl'), 'E:\\wsl');
	});

	it('maps a bare drive mount to the drive root', () => {
		assert.equal(linuxToWindowsPath('Ubuntu', '/mnt/d'), 'D:\\');
	});

	it('maps other paths into the distro share', () => {
		assert.equal(linuxToWindowsPath('Ubuntu', '/home/user/b.vhdx'), '\\\\wsl.localhost\\Ubuntu\\home\\user\\b.vhdx');
	});

	it('does not treat multi-letter /mnt folders as drives', () => {
		assert.equal(linuxToWindowsPath('Ubuntu', '/mnt/wsl/x'), '\\\\wsl.localhost\\Ubuntu\\mnt\\wsl\\x');
	});
});

describe('isInsideDistro', () => {
	it('detects both distro share prefixes', () => {
		assert.equal(isInsideDistro('\\\\wsl.localhost\\Ubuntu\\home'), true);
		assert.equal(isInsideDistro('\\\\wsl$\\Ubuntu\\home'), true);
		assert.equal(isInsideDistro('\\\\WSL.LOCALHOST\\Ubuntu'), true);
	});

	it('rejects drive paths and other network shares', () => {
		assert.equal(isInsideDistro('C:\\WSL\\Ubuntu'), false);
		assert.equal(isInsideDistro('\\\\server\\share'), false);
	});
});

describe('toWindowsPath', () => {
	it('converts vscode-remote WSL URIs without calling wslpath', async () => {
		const uri = Uri.from({ scheme: 'vscode-remote', authority: 'wsl+FedoraLinux-43', path: '/mnt/e/backup.tar' });
		assert.equal(await toWindowsPath(uri as never), 'E:\\backup.tar');
	});

	it('decodes an encoded distro name in the authority', async () => {
		const uri = Uri.from({ scheme: 'vscode-remote', authority: 'wsl+My%20Distro', path: '/root' });
		assert.equal(await toWindowsPath(uri as never), '\\\\wsl.localhost\\My Distro\\root');
	});

	it('rejects locations wsl.exe cannot reach', async () => {
		const uri = Uri.from({ scheme: 'vscode-remote', authority: 'ssh-remote+server', path: '/a' });
		await assert.rejects(toWindowsPath(uri as never), /Unsupported location/);
	});
});

describe('currentWindowDistro', () => {
	const savedDistroName = process.env.WSL_DISTRO_NAME;

	afterEach(() => {
		env.remoteName = undefined;
		workspace.workspaceFolders = undefined;
		workspace.workspaceFile = undefined;
		if (savedDistroName === undefined) {
			delete process.env.WSL_DISTRO_NAME;
		} else {
			process.env.WSL_DISTRO_NAME = savedDistroName;
		}
	});

	it('is undefined for a window that is not connected to WSL', () => {
		process.env.WSL_DISTRO_NAME = 'Ubuntu';
		assert.equal(currentWindowDistro(), undefined);
		assert.equal(isCurrentWindowDistro('Ubuntu'), false);
	});

	it('uses WSL_DISTRO_NAME on the remote host', { skip: process.platform === 'win32' }, () => {
		env.remoteName = 'wsl';
		process.env.WSL_DISTRO_NAME = 'FedoraLinux-43';
		assert.equal(currentWindowDistro(), 'FedoraLinux-43');
	});

	it('falls back to the workspace authority', () => {
		env.remoteName = 'wsl';
		delete process.env.WSL_DISTRO_NAME;
		workspace.workspaceFolders = [{ uri: Uri.from({ scheme: 'vscode-remote', authority: 'wsl+ubuntu-24.04', path: '/home' }) }];
		assert.equal(currentWindowDistro(), 'ubuntu-24.04');
	});

	it('prefers the workspace file over the first folder', () => {
		env.remoteName = 'wsl';
		delete process.env.WSL_DISTRO_NAME;
		workspace.workspaceFile = Uri.from({ scheme: 'vscode-remote', authority: 'wsl+Debian', path: '/w.code-workspace' });
		workspace.workspaceFolders = [{ uri: Uri.from({ scheme: 'vscode-remote', authority: 'wsl+Ubuntu', path: '/' }) }];
		assert.equal(currentWindowDistro(), 'Debian');
	});

	it('compares names case-insensitively', () => {
		env.remoteName = 'wsl';
		delete process.env.WSL_DISTRO_NAME;
		workspace.workspaceFolders = [{ uri: Uri.from({ scheme: 'vscode-remote', authority: 'wsl+ubuntu-24.04', path: '/' }) }];
		assert.equal(isCurrentWindowDistro('Ubuntu-24.04'), true);
		assert.equal(isCurrentWindowDistro('Debian'), false);
	});
});
