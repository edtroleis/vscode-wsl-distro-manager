import { ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { list, spawnInDistro, windowsTempDir } from './wsl';

const defaultSharedDir = windowsTempDir;

/**
 * On WSL 2 every distro shares the same VM, but each one has its own PID
 * namespace. Summing /proc/<pid>/stat inside the distro therefore gives that
 * distro's usage; /proc/stat and /proc/meminfo give the VM totals.
 *
 * A single looping process emits one line per sample instead of spawning a
 * wsl.exe on every tick. When wsl.exe dies, the next echo gets SIGPIPE and the
 * loop inside the distro ends on its own.
 *
 * Line: S <cpuTotal> <cpuIdle> <procJiffies> <rssPages> <procs> <memTotalKb> <memAvailKb> <pageSize> <ncpu>
 */
function script(intervalSeconds: number): string {
	return [
		'n=$(nproc 2>/dev/null || echo 1); pg=$(getconf PAGESIZE 2>/dev/null || echo 4096)',
		'while :; do',
		"c=$(awk '/^cpu /{t=0; for(i=2;i<=9;i++) t+=$i; print t, $5+$6}' /proc/stat)",
		"p=$(cat /proc/[0-9]*/stat 2>/dev/null | awk '{sub(/^.*\\) /, \"\"); u+=$12+$13; r+=$22; k++} END{print u+0, r+0, k+0}')",
		"m=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print t, a}' /proc/meminfo)",
		'echo "S $c $p $m $pg $n"',
		`sleep ${intervalSeconds}`,
		'done',
	].join('\n');
}

export interface Sample {
	cpuTotal: number;
	cpuIdle: number;
	procJiffies: number;
	rssBytes: number;
	procs: number;
	memTotal: number;
	memAvail: number;
	ncpu: number;
}

export function parseSample(line: string): Sample | undefined {
	const f = line.trim().split(/\s+/);
	if (f[0] !== 'S' || f.length < 10) {
		return undefined;
	}
	const n = f.slice(1).map(Number);
	if (n.some((v) => !Number.isFinite(v))) {
		return undefined;
	}
	const [cpuTotal, cpuIdle, procJiffies, rssPages, procs, memTotalKb, memAvailKb, pageSize, ncpu] = n;
	return {
		cpuTotal,
		cpuIdle,
		procJiffies,
		rssBytes: rssPages * pageSize,
		procs,
		memTotal: memTotalKb * 1024,
		memAvail: memAvailKb * 1024,
		ncpu,
	};
}

export function formatBytes(bytes: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function bar(fraction: number): string {
	const width = 10;
	const filled = Math.round(Math.min(Math.max(fraction, 0), 1) * width);
	return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export class MetricItem extends vscode.TreeItem {
	constructor(id: string, label: string, icon: string) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.id = id;
		this.iconPath = new vscode.ThemeIcon(icon);
		this.contextValue = 'wslMetric';
		this.description = 'waiting...';
	}
}

export interface MonitorOptions {
	/** Folder shared by every VS Code window on this machine (Windows %TEMP%). */
	sharedDir?: () => Promise<string>;
	/** Starts the sampling process; the tests replace it. */
	spawn?: (distro: string, script: string) => ChildProcess;
	/** Sampling interval; defaults to wslManager.metricsIntervalSeconds. */
	intervalMs?: number;
	/** Whether the distro still runs; checked before taking over from a leader. */
	isRunning?: (distro: string) => Promise<boolean>;
}

const defaultIsRunning = async (distro: string) => (await list()).some((d) => d.name === distro && d.running);

/**
 * Live metrics for one distro, shared by every VS Code window.
 *
 * Each window runs its own extension host, possibly on different sides
 * (Windows or WSL), and a sampling process per window would multiply the load
 * and each would keep the distro alive. Instead, one window is the leader: it
 * holds a lock file in the Windows temp folder, which both sides can reach,
 * runs the sampling process, and writes every sample line next to the lock.
 * The other windows follow by reading that file. When the leader stops it
 * deletes the lock and a follower takes over at once; when it disappears
 * without cleaning up, a follower takes over once the sample file has not
 * changed for a while. That is judged by the follower's own clock, never by
 * file times: the WSL VM clock can drift seconds away from Windows, which made
 * a fresh lock look abandoned from the other side. Samples carry cumulative
 * counters, so the file changes with every sample, and followers compute CPU
 * deltas themselves.
 */
export class DistroMonitor implements vscode.Disposable {
	readonly cpu: MetricItem;
	readonly memory: MetricItem;
	readonly processes: MetricItem;

	private child: ChildProcess | undefined;
	private followTimer: NodeJS.Timeout | undefined;
	private previous: Sample | undefined;
	private lastLine: string | undefined;
	/** Bumped by start/stop so an async start that lost the race does nothing. */
	private generation = 0;
	private running = false;
	private readonly owner = `${os.hostname()}-${process.pid}-${Math.random().toString(36).slice(2)}`;

	constructor(
		readonly distro: string,
		private readonly onUpdate: (items: MetricItem[]) => void,
		private readonly options: MonitorOptions = {},
	) {
		const base = `distro/${distro}/metric`;
		this.cpu = new MetricItem(`${base}/cpu`, 'CPU', 'pulse');
		this.memory = new MetricItem(`${base}/memory`, 'Memory', 'server');
		this.processes = new MetricItem(`${base}/procs`, 'Processes', 'list-tree');
	}

	get items(): MetricItem[] {
		return [this.cpu, this.memory, this.processes];
	}

	get active(): boolean {
		return this.running;
	}

	/** Whether this window runs the sampling process (false when following another window). */
	get isLeader(): boolean {
		return this.child !== undefined;
	}

	private get intervalMs(): number {
		return (
			this.options.intervalMs ??
			Math.max(1, vscode.workspace.getConfiguration('wslManager').get<number>('metricsIntervalSeconds', 2)) * 1000
		);
	}

	/** A sample file unchanged for this long belongs to a window that stopped sampling. */
	private get staleMs(): number {
		return this.intervalMs * 3 + 2000;
	}

	start(): void {
		if (this.running) {
			return;
		}
		this.running = true;
		this.previous = undefined;
		this.lastLine = undefined;
		const generation = ++this.generation;
		this.paths()
			.then((paths) => (generation === this.generation ? this.lead(paths, generation) : undefined))
			.catch(() => {
				// No shared folder: sample on our own, as a window without peers would.
				if (generation === this.generation) {
					this.spawnSampler(undefined);
				}
			});
	}

	stop(): void {
		if (!this.running) {
			return;
		}
		this.generation++;
		this.stopSampling('paused');
	}

	dispose(): void {
		this.stop();
	}

	private async paths(): Promise<{ lock: string; sample: string }> {
		const dir = path.join(await (this.options.sharedDir ?? defaultSharedDir)(), 'wsl-distro-manager');
		await fs.mkdir(dir, { recursive: true });
		const key = encodeURIComponent(this.distro);
		return { lock: path.join(dir, `${key}.lock`), sample: path.join(dir, `${key}.sample`) };
	}

	/** Takes the lock if it is free or stale; otherwise follows its holder. */
	private async lead(paths: { lock: string; sample: string }, generation: number): Promise<void> {
		if (await this.tryLock(paths.lock, false)) {
			if (generation === this.generation) {
				this.spawnSampler(paths);
			} else {
				await fs.rm(paths.lock, { force: true });
			}
			return;
		}
		if (generation !== this.generation) {
			return;
		}
		let lastChange = Date.now();
		const poll = async () => {
			const line = await fs.readFile(paths.sample, 'utf8').catch(() => undefined);
			if (generation !== this.generation) {
				return;
			}
			if (line && line !== this.lastLine) {
				lastChange = Date.now();
				this.lastLine = line;
				const sample = parseSample(line);
				if (sample) {
					this.apply(sample);
				}
			}
			const leaderGone = Date.now() - lastChange > this.staleMs;
			if (await this.tryLock(paths.lock, leaderGone)) {
				clearInterval(this.followTimer);
				this.followTimer = undefined;
				// The leader usually lets go because the distro stopped; sampling
				// it now would boot it again.
				const alive = await (this.options.isRunning ?? defaultIsRunning)(this.distro).catch(() => false);
				if (generation === this.generation && alive) {
					this.spawnSampler(paths);
					return;
				}
				await fs.rm(paths.lock, { force: true });
				if (generation === this.generation) {
					this.markStopped('stopped');
				}
			}
		};
		this.followTimer = setInterval(() => void poll(), this.intervalMs);
		void poll();
	}

	/** Creates the lock if nobody holds it; with `steal`, replaces an abandoned one. */
	private async tryLock(lock: string, steal: boolean): Promise<boolean> {
		try {
			await fs.writeFile(lock, this.owner, { flag: 'wx' });
			return true;
		} catch {
			if (!steal) {
				return false;
			}
			await fs.rm(lock, { force: true });
			try {
				await fs.writeFile(lock, this.owner, { flag: 'wx' });
				return true;
			} catch {
				return false;
			}
		}
	}

	private spawnSampler(paths: { lock: string; sample: string } | undefined): void {
		const child = (this.options.spawn ?? spawnInDistro)(this.distro, script(Math.max(1, Math.round(this.intervalMs / 1000))));
		this.child = child;
		let pending = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			pending += chunk.toString('utf8');
			const lines = pending.split('\n');
			pending = lines.pop() ?? '';
			for (const line of lines) {
				const sample = parseSample(line);
				if (!sample) {
					continue;
				}
				this.apply(sample);
				if (paths) {
					// Share the sample; its changing content tells followers we are alive.
					const temp = `${paths.sample}.${process.pid}.tmp`;
					void fs
						.writeFile(temp, line.trim())
						.then(() => fs.rename(temp, paths.sample))
						.catch(() => undefined);
				}
			}
		});
		const release = () => (paths ? fs.readFile(paths.lock, 'utf8').then(
			(holder) => (holder === this.owner ? fs.rm(paths.lock, { force: true }) : undefined),
			() => undefined,
		) : Promise.resolve());
		child.on('error', () => {
			void release();
			this.finish(child, 'unavailable');
		});
		child.on('close', () => {
			void release();
			this.finish(child, 'stopped');
		});
	}

	private stopSampling(status: string): void {
		clearInterval(this.followTimer);
		this.followTimer = undefined;
		const child = this.child;
		if (child) {
			this.finish(child, status);
			child.kill();
		} else {
			this.markStopped(status);
		}
	}

	private finish(child: ChildProcess, status: string): void {
		if (this.child !== child) {
			return;
		}
		this.child = undefined;
		clearInterval(this.followTimer);
		this.followTimer = undefined;
		this.markStopped(status);
	}

	private markStopped(status: string): void {
		this.running = false;
		this.previous = undefined;
		for (const item of this.items) {
			item.description = status;
			item.tooltip = undefined;
		}
		this.onUpdate(this.items);
	}

	private apply(sample: Sample): void {
		const memUsedVm = sample.memTotal - sample.memAvail;
		this.memory.description = `${bar(sample.rssBytes / sample.memTotal)} ${formatBytes(sample.rssBytes)}`;
		this.memory.tooltip =
			`Distro: ${formatBytes(sample.rssBytes)} (sum of process RSS; shared pages are counted more than once)\n` +
			`WSL VM: ${formatBytes(memUsedVm)} used of ${formatBytes(sample.memTotal)} ` +
			`(${((memUsedVm / sample.memTotal) * 100).toFixed(0)}%)`;
		this.processes.description = String(sample.procs);

		const prev = this.previous;
		this.previous = sample;
		if (prev) {
			const total = sample.cpuTotal - prev.cpuTotal;
			if (total > 0) {
				// Processes that exited between samples drop out of the sum; never go negative.
				const distro = Math.max(0, sample.procJiffies - prev.procJiffies) / total;
				const vm = 1 - Math.max(0, sample.cpuIdle - prev.cpuIdle) / total;
				this.cpu.description = `${bar(distro)} ${(distro * 100).toFixed(1)}%`;
				this.cpu.tooltip =
					`Distro: ${(distro * 100).toFixed(1)}% of the VM (${(distro * sample.ncpu * 100).toFixed(0)}% of one core)\n` +
					`WSL VM: ${(vm * 100).toFixed(1)}% of ${sample.ncpu} cores`;
			}
		}
		this.onUpdate(this.items);
	}
}
