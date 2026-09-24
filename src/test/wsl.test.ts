import assert = require('node:assert/strict');
import { afterEach, describe, it } from 'node:test';
import {
	currentWindowDistro,
	decode,
	diskpartScript,
	system32,
	wslExePath,
	encodePowerShell,
	interopBroken,
	interopMissingFromListing,
	isAscii,
	list,
	isCurrentWindowDistro,
	isInsideDistro,
	linuxToWindowsPath,
	managedBy,
	parseDistroList,
	parseRegistry,
	parseOnlineList,
	parseRuntimeInfo,
	run,
	CancelledError,
	parseVscodeConnectedDistros,
	toWindowsPath,
} from '../wsl';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Uri, env, settings, workspace } from './vscode.mock';

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
	it('maps each line to its field and converts disk KB to bytes', () => {
		const info = parseRuntimeInfo('Fedora Linux 43 (WSL)\n6.18.33.2-microsoft-standard-WSL2\nuser\n68517252\n1055762868\n');
		assert.deepEqual(info, {
			prettyName: 'Fedora Linux 43 (WSL)',
			kernel: '6.18.33.2-microsoft-standard-WSL2',
			user: 'user',
			diskUsed: 68517252 * 1024,
			diskSize: 1055762868 * 1024,
		});
	});

	it('ignores non-numeric disk values', () => {
		const info = parseRuntimeInfo('X\n6.6\nroot\ndf: not found\n\n');
		assert.equal(info.diskUsed, undefined);
		assert.equal(info.diskSize, undefined);
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

describe('managedBy', () => {
	it('recognizes distros created by container tools', () => {
		assert.equal(managedBy('docker-desktop')?.tool, 'Docker Desktop');
		assert.equal(managedBy('docker-desktop-data')?.tool, 'Docker Desktop');
		assert.equal(managedBy('podman-machine-default')?.tool, 'Podman');
		assert.equal(managedBy('podman-net-usermode')?.tool, 'Podman');
		assert.equal(managedBy('rancher-desktop')?.tool, 'Rancher Desktop');
	});

	it('leaves regular distros alone, including look-alike names', () => {
		for (const name of ['Ubuntu-24.04', 'fedora-linux-43', 'my-docker-desktop', 'docker-desktop-2', 'podman']) {
			assert.equal(managedBy(name), undefined, name);
		}
	});

	it('explains how to manage the distro instead', () => {
		assert.match(managedBy('podman-machine-default')?.hint ?? '', /podman machine/);
	});
});

describe('interopBroken', { skip: process.platform === 'win32' }, () => {
	function binfmt(...entries: string[]): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binfmt-'));
		entries.forEach((e) => fs.writeFileSync(path.join(dir, e), ''));
		return dir;
	}

	it('is false while the WSLInterop entry is registered', () => {
		assert.equal(interopBroken(binfmt('register', 'status', 'WSLInterop')), false);
	});

	it('accepts the WSLInterop-late entry used by newer WSL versions', () => {
		assert.equal(interopBroken(binfmt('register', 'status', 'WSLInterop-late')), false);
	});

	it('is true when another distro unregistered it', () => {
		assert.equal(interopBroken(binfmt('register', 'status')), true);
	});

	it('does not guess when binfmt_misc is not mounted', () => {
		assert.equal(interopBroken(binfmt()), false);
		assert.equal(interopBroken('/nonexistent/binfmt_misc'), false);
	});
});

describe('parseVscodeConnectedDistros', () => {
	// Command lines of the wsl.exe processes VS Code runs on Windows, as seen in a real session.
	const lines = [
		`C:\\WINDOWS\\System32\\wsl.exe -d fedora-linux-43 sh -c '"$VSCODE_WSL_EXT_LOCATION/scripts/wslServer.sh" f6cfa2 stable code-server .vscode-server --host=127.0.0.1'`,
		`C:\\WINDOWS\\System32\\wsl.exe -d fedora-linux-43 -e /home/user/.vscode-server/bin/f6cfa2/node -e "const net = require('net');"`,
		`C:\\WINDOWS\\system32\\wsl.exe -d fedora-linux-43 -e /bin/sh -c "cd '/home/user/code' && /bin/sh"`,
		`wsl.exe --distribution Ubuntu-24.04 --exec /bin/sh -c "while :; do sleep 2; done"`,
		`"C:\\WINDOWS\\system32\\wsl.exe" --distribution FedoraLinux-43 --exec /bin/sleep 2147483647`,
	].join('\r\n');

	it('finds distros running a VS Code server, once each', () => {
		assert.deepEqual(parseVscodeConnectedDistros(lines), ['fedora-linux-43']);
	});

	it('ignores terminals, monitors, and keep-alive sessions', () => {
		const others = lines.split('\r\n').slice(2).join('\n');
		assert.deepEqual(parseVscodeConnectedDistros(others), []);
	});

	it('handles --distribution and quoted names', () => {
		assert.deepEqual(
			parseVscodeConnectedDistros('wsl.exe --distribution "My Distro" -e /home/u/.vscode-server/bin/x/node'),
			['My Distro'],
		);
	});
});

describe('parseOnlineList', () => {
	// Real `wsl --list --online` output on a Portuguese Windows: the intro is localized, the table is not.
	const output = [
		'A seguir está uma lista de distribuições válidas que podem ser instaladas.',
		"Instale usando 'wsl.exe --install <Distro>'.",
		'',
		'NAME                            FRIENDLY NAME',
		'Ubuntu                          Ubuntu',
		'Ubuntu-24.04                    Ubuntu 24.04 LTS',
		'SUSE-Linux-Enterprise-15-SP7    SUSE Linux Enterprise 15 SP7',
		'Debian                          Debian GNU/Linux',
		'',
	].join('\r\n');

	it('reads name and friendly name from each row', () => {
		assert.deepEqual(parseOnlineList(output), [
			{ name: 'Ubuntu', friendlyName: 'Ubuntu' },
			{ name: 'Ubuntu-24.04', friendlyName: 'Ubuntu 24.04 LTS' },
			{ name: 'SUSE-Linux-Enterprise-15-SP7', friendlyName: 'SUSE Linux Enterprise 15 SP7' },
			{ name: 'Debian', friendlyName: 'Debian GNU/Linux' },
		]);
	});

	it('ignores the localized intro, whatever language it is in', () => {
		assert.equal(parseOnlineList(output.replace('A seguir está', 'The following is')).length, 4);
	});

	it('returns nothing when there is no table (offline, error)', () => {
		assert.deepEqual(parseOnlineList('Failed to fetch the list of distributions.\r\n'), []);
	});
});

describe('run cancellation', { skip: process.platform === 'win32' }, () => {
	afterEach(() => {
		delete settings['wslExePath'];
	});

	it('kills the process and rejects with CancelledError when aborted', async () => {
		settings['wslExePath'] = '/bin/sleep';
		const controller = new AbortController();
		const started = Date.now();
		setTimeout(() => controller.abort(), 100);
		await assert.rejects(run(['10'], { signal: controller.signal }), CancelledError);
		assert.ok(Date.now() - started < 3000);
	});

	it('does not start work that was already cancelled', async () => {
		settings['wslExePath'] = '/bin/sleep';
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(run(['10'], { signal: controller.signal }), CancelledError);
	});
});

describe('isAscii', () => {
	it('accepts plain Windows paths and rejects accented ones (which diskpart cannot read)', () => {
		assert.equal(isAscii('E:\\wsl\\fedora-linux-43\\ext4.vhdx'), true);
		assert.equal(isAscii('C:\\Users\\joão\\AppData\\Local\\wsl\\ext4.vhdx'), false);
		assert.equal(isAscii('C:\\Users\\edtro\\OneDrive\\READET~1'), true);
	});
});

describe('list with no distro installed', { skip: process.platform === 'win32' }, () => {
	afterEach(() => {
		delete settings['wslExePath'];
	});

	it('returns an empty list instead of failing, so the welcome view shows', async () => {
		// wsl.exe with no distros: a localized message and a non-zero exit code.
		const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-')), 'wsl');
		fs.writeFileSync(fake, '#!/bin/sh\necho "O Subsistema do Windows para Linux nao tem distribuicoes instaladas."\nexit 1\n', { mode: 0o755 });
		settings['wslExePath'] = fake;
		assert.deepEqual(await list(), []);
	});
});

describe('interopMissingFromListing', () => {
	it('is false while WSLInterop (or WSLInterop-late) is registered', () => {
		assert.equal(interopMissingFromListing('WSLInterop\nqemu-aarch64\nregister\nstatus\n'), false);
		assert.equal(interopMissingFromListing('WSLInterop-late register status'), false);
	});

	it('is true when binfmt_misc is mounted but the entry is gone', () => {
		assert.equal(interopMissingFromListing('qemu-aarch64\nregister\nstatus\n'), true);
	});

	it('does not guess when binfmt_misc is not mounted', () => {
		assert.equal(interopMissingFromListing(''), false);
	});
});

describe('diskpart script', () => {
	it('pipes the commands to diskpart and writes its output to the log, with no temp script file', () => {
		const script = diskpartScript('E:\\wsl\\Ubuntu\\ext4.vhdx', "C:\\Temp\\it's.log");
		assert.match(script, /'select vdisk file="E:\\wsl\\Ubuntu\\ext4\.vhdx"', 'attach vdisk readonly', 'compact vdisk', 'detach vdisk', 'exit'/);
		// diskpart by absolute path: a same-named program elsewhere in the PATH must not run elevated.
		assert.match(script, /\| & "\$env:SystemRoot\\System32\\diskpart\.exe" 2>&1 \| Out-File -FilePath 'C:\\Temp\\it''s\.log'/);
		assert.match(script, /exit \$LASTEXITCODE$/);
	});

	it('encodes for -EncodedCommand as base64 of UTF-16LE', () => {
		assert.equal(Buffer.from(encodePowerShell('exit 0'), 'base64').toString('utf16le'), 'exit 0');
	});
});

describe('system32', { skip: process.platform === 'win32' }, () => {
	it('names Windows programs by absolute path, never by bare name', () => {
		assert.equal(system32('reg.exe'), '/mnt/c/Windows/System32/reg.exe');
		assert.equal(system32('WindowsPowerShell\\v1.0\\powershell.exe'), '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
		assert.equal(wslExePath(), '/mnt/c/Windows/System32/wsl.exe');
	});
});
