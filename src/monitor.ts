import { ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import { spawnInDistro } from './wsl';

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

export class DistroMonitor implements vscode.Disposable {
	readonly cpu: MetricItem;
	readonly memory: MetricItem;
	readonly processes: MetricItem;

	private child: ChildProcess | undefined;
	private previous: Sample | undefined;

	constructor(
		readonly distro: string,
		private readonly onUpdate: (items: MetricItem[]) => void,
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
		return this.child !== undefined;
	}

	start(): void {
		if (this.child) {
			return;
		}
		const interval = Math.max(
			1,
			vscode.workspace.getConfiguration('wslManager').get<number>('metricsIntervalSeconds', 2),
		);
		const child = spawnInDistro(this.distro, script(interval));
		this.child = child;
		this.previous = undefined;

		let pending = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			pending += chunk.toString('utf8');
			const lines = pending.split('\n');
			pending = lines.pop() ?? '';
			for (const line of lines) {
				const sample = parseSample(line);
				if (sample) {
					this.apply(sample);
				}
			}
		});
		child.on('error', () => this.finish(child, 'unavailable'));
		child.on('close', () => this.finish(child, 'stopped'));
	}

	stop(): void {
		const child = this.child;
		if (child) {
			this.finish(child, 'paused');
			child.kill();
		}
	}

	dispose(): void {
		this.stop();
	}

	private finish(child: ChildProcess, status: string): void {
		if (this.child !== child) {
			return;
		}
		this.child = undefined;
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
