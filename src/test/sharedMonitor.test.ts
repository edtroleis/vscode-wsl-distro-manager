import assert = require('node:assert/strict');
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it } from 'node:test';
import { ChildProcess } from 'child_process';
import { DistroMonitor, MonitorOptions } from '../monitor';

/** Stand-in for the wsl.exe sampling process: tests write sample lines to it. */
class FakeSampler extends EventEmitter {
	stdout = new PassThrough();
	killed = false;
	kill(): boolean {
		this.killed = true;
		setImmediate(() => this.emit('close', 0));
		return true;
	}
	emitSample(procs: number): void {
		this.stdout.write(`S 1000 900 50 1000 ${procs} 16000000 12000000 4096 8\n`);
	}
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error('timed out');
		}
		await new Promise((r) => setTimeout(r, 20));
	}
}

describe('DistroMonitor shared between windows', () => {
	const monitors: DistroMonitor[] = [];
	let dir: string;
	const samplers: FakeSampler[] = [];
	let running = true;

	function monitor(overrides: MonitorOptions = {}): DistroMonitor {
		const m = new DistroMonitor('Ubuntu', () => undefined, {
			sharedDir: async () => dir,
			spawn: () => {
				const s = new FakeSampler();
				samplers.push(s);
				return s as unknown as ChildProcess;
			},
			intervalMs: 100,
			isRunning: async () => running,
			...overrides,
		});
		monitors.push(m);
		return m;
	}

	function fresh(): void {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-'));
		samplers.length = 0;
		running = true;
	}

	afterEach(() => {
		monitors.splice(0).forEach((m) => m.dispose());
	});

	it('runs one sampling process for two windows, and both show its samples', async () => {
		fresh();
		const a = monitor();
		a.start();
		await waitFor(() => a.isLeader);
		const b = monitor();
		b.start();
		await new Promise((r) => setTimeout(r, 150));

		assert.equal(samplers.length, 1);
		assert.equal(b.isLeader, false);
		samplers[0].emitSample(42);
		await waitFor(() => b.processes.description === '42');
		assert.equal(a.processes.description, '42');
	});

	it('hands sampling over to a follower when the leader window stops', async () => {
		fresh();
		const a = monitor();
		a.start();
		await waitFor(() => a.isLeader);
		const b = monitor();
		b.start();
		await new Promise((r) => setTimeout(r, 150));

		a.stop();
		await waitFor(() => b.isLeader);
		assert.equal(samplers.length, 2);
		assert.equal(samplers[0].killed, true);
	});

	it('does not boot a distro that stopped when the leader lets go', async () => {
		fresh();
		const a = monitor();
		a.start();
		await waitFor(() => a.isLeader);
		const b = monitor();
		b.start();
		await new Promise((r) => setTimeout(r, 150));

		running = false;
		samplers[0].kill(); // the distro stopped: the sampling process ends
		await waitFor(() => b.processes.description === 'stopped');
		assert.equal(samplers.length, 1);
		assert.equal(b.active, false);
	});

	it('takes over a lock left behind by a window that disappeared', async () => {
		fresh();
		const lock = path.join(dir, 'wsl-distro-manager', 'Ubuntu.lock');
		fs.mkdirSync(path.dirname(lock), { recursive: true });
		fs.writeFileSync(lock, 'crashed-window');

		const m = monitor();
		m.start();
		await new Promise((r) => setTimeout(r, 500));
		assert.equal(m.isLeader, false, 'waits for the sample file to go quiet first');
		await waitFor(() => m.isLeader, 6000);
		assert.notEqual(fs.readFileSync(lock, 'utf8'), 'crashed-window');
	});

	it('does not take a fresh lock even when its file time looks old (clock drift)', async () => {
		fresh();
		const a = monitor();
		a.start();
		await waitFor(() => a.isLeader);
		const lock = path.join(dir, 'wsl-distro-manager', 'Ubuntu.lock');
		const skewed = new Date(Date.now() - 60_000);
		fs.utimesSync(lock, skewed, skewed);

		const b = monitor();
		b.start();
		for (let i = 0; i < 10; i++) {
			samplers[0].emitSample(i);
			await new Promise((r) => setTimeout(r, 100));
		}
		assert.equal(b.isLeader, false);
		assert.equal(samplers.length, 1);
	});

	it('releases the lock when it stops', async () => {
		fresh();
		const m = monitor();
		m.start();
		await waitFor(() => m.isLeader);
		m.stop();
		const lock = path.join(dir, 'wsl-distro-manager', 'Ubuntu.lock');
		await waitFor(() => !fs.existsSync(lock));
	});

	it('samples on its own when the shared folder is unavailable', async () => {
		fresh();
		const m = monitor({ sharedDir: async () => Promise.reject(new Error('no interop')) });
		m.start();
		await waitFor(() => m.isLeader);
		samplers[0].emitSample(7);
		await waitFor(() => m.processes.description === '7');
	});
});
