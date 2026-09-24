/**
 * Smoke test against the real WSL installation: calls the same functions the
 * extension uses, on whichever host runs it (Windows or a WSL distro), and
 * prints what each one returned. Read-only: it never starts, stops, or changes
 * a distro, and only queries distros that are already running.
 *
 *   npm run smoke            # on this host
 *   npm run smoke:windows    # from WSL, on the Windows host via VS Code's Node
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { Uri } from './vscode.mock';
import * as wsl from '../wsl';
import { DistroMonitor } from '../monitor';

/** Starts a real monitor, waits for two samples (the first CPU value needs a delta), then stops it. */
function sampleMetrics(distro: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let samples = 0;
		const monitor = new DistroMonitor(distro, () => {
			if (monitor.active && ++samples === 2) {
				const summary = monitor.items.map((i) => `${i.label} ${i.description}`).join(' | ');
				monitor.stop();
				clearTimeout(timer);
				resolve(summary);
			}
		});
		const timer = setTimeout(() => {
			monitor.stop();
			reject(new Error(`only ${samples} sample(s) in 15 s`));
		}, 15_000);
		monitor.start();
	});
}

let failures = 0;

async function check<T>(label: string, run: () => Promise<T>, show: (value: T) => string = String): Promise<T | undefined> {
	try {
		const value = await run();
		console.log(`  ok    ${label}: ${show(value)}`);
		return value;
	} catch (error) {
		failures++;
		console.log(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

async function main(): Promise<void> {
	console.log(`host: ${process.platform} (node ${process.version})`);
	console.log(`wsl.exe: ${wsl.wslExePath()}\n`);

	const distros = await check('list distros', () => wsl.list(), (ds) =>
		ds.map((d) => `${d.name}${d.isDefault ? '*' : ''} [v${d.version} ${d.state}]`).join(', '),
	);
	const registry = await check('read registry', () => wsl.registryInfo(), (r) => `${r.size} distros`);
	await check('Windows home', () => wsl.windowsHomeDir());
	const temp = await check('Windows temp', () => wsl.windowsTempDir());
	if (temp) {
		await check('Windows temp is writable', async () => {
			const probe = path.join(temp, `wsl-distro-manager-smoke-${process.pid}`);
			await fs.writeFile(probe, 'x');
			await fs.rm(probe);
			return 'yes';
		});
		await check('dialog path → wsl.exe path', () => wsl.toWindowsPath(Uri.file(temp) as never));
	}

	await check('distros with VS Code connected', () => wsl.vscodeConnectedDistros(), (d) => d.join(', ') || 'none');

	for (const distro of distros ?? []) {
		console.log(`\n${distro.name}${wsl.managedBy(distro.name) ? ` (managed by ${wsl.managedBy(distro.name)?.tool})` : ''}`);
		const entry = registry?.get(distro.name);
		if (!entry?.basePath || !entry.vhdFileName) {
			console.log('  --    no VHDX in the registry (WSL 1 or unusual install)');
			continue;
		}
		const vhd = path.win32.join(entry.basePath, entry.vhdFileName);
		await check('VHDX size', async () => (await fs.stat(await wsl.toHostPath(vhd))).size, (b) => `${(b / 1024 ** 3).toFixed(1)} GB`);
		await check('VHDX locked by the WSL VM', () => wsl.isFileLocked(vhd), (locked) => (locked ? 'yes' : 'no'));
		if (!distro.running) {
			console.log('  --    stopped: skipping in-distro queries');
			continue;
		}
		await check('runtime info', () => wsl.runtimeInfo(distro.name), (i) =>
			`${i.prettyName} | ${i.kernel} | user ${i.user} | used ${((i.diskUsed ?? 0) / 1024 ** 3).toFixed(1)} GB`,
		);
		await check('live metrics', () => sampleMetrics(distro.name));
	}

	console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
	process.exitCode = failures ? 1 : 0;
}

main();
