import assert = require('node:assert/strict');
import { describe, it } from 'node:test';
import { DistroMonitor, Sample, bar, formatBytes, parseSample } from '../monitor';

function sample(overrides: Partial<Sample> = {}): Sample {
	return {
		cpuTotal: 10_000,
		cpuIdle: 8_000,
		procJiffies: 500,
		rssBytes: 1024 ** 3,
		procs: 60,
		memTotal: 16 * 1024 **3,
		memAvail: 12 * 1024 ** 3,
		ncpu: 8,
		...overrides,
	};
}

/** apply() is private: it is what runs for every line the distro streams back. */
function feed(monitor: DistroMonitor, s: Sample): void {
	(monitor as unknown as { apply(s: Sample): void }).apply(s);
}

describe('parseSample', () => {
	it('parses a line from the sampling script', () => {
		assert.deepEqual(parseSample('S 1544155 1440936 13431 683439 60 25642616 23010880 4096 8'), {
			cpuTotal: 1544155,
			cpuIdle: 1440936,
			procJiffies: 13431,
			rssBytes: 683439 * 4096,
			procs: 60,
			memTotal: 25642616 * 1024,
			memAvail: 23010880 * 1024,
			ncpu: 8,
		});
	});

	it('tolerates surrounding whitespace and CR', () => {
		assert.ok(parseSample('  S 1 1 1 1 1 1 1 4096 1\r'));
	});

	it('rejects other lines, short lines, and non-numeric fields', () => {
		assert.equal(parseSample('sh: 1: getconf: not found'), undefined);
		assert.equal(parseSample('S 1 2 3'), undefined);
		assert.equal(parseSample('S 1 2 3 x 5 6 7 8 9'), undefined);
		assert.equal(parseSample(''), undefined);
	});
});

describe('formatBytes', () => {
	it('uses binary units with one decimal above bytes', () => {
		assert.equal(formatBytes(0), '0 B');
		assert.equal(formatBytes(1023), '1023 B');
		assert.equal(formatBytes(1024), '1.0 KB');
		assert.equal(formatBytes(1.5 * 1024 ** 2), '1.5 MB');
		assert.equal(formatBytes(79124496384), '73.7 GB');
	});

	it('stops at TB', () => {
		assert.equal(formatBytes(2048 * 1024 ** 4), '2048.0 TB');
	});
});

describe('bar', () => {
	it('fills proportionally in ten steps', () => {
		assert.equal(bar(0), '░░░░░░░░░░');
		assert.equal(bar(0.5), '█████░░░░░');
		assert.equal(bar(1), '██████████');
	});

	it('clamps out-of-range values', () => {
		assert.equal(bar(-1), bar(0));
		assert.equal(bar(3), bar(1));
	});
});

describe('DistroMonitor', () => {
	it('shows memory and process count from the first sample, CPU only from the second', () => {
		const monitor = new DistroMonitor('Ubuntu', () => undefined);
		feed(monitor, sample());

		// 16 GB total, 12 GB available: the VM uses 4 GB.
		assert.equal(monitor.memory.description, `${bar(1 / 16)} 1.0 GB · VM 4.0 GB of 16.0 GB`);
		assert.equal(monitor.processes.description, '60');
		assert.equal(monitor.cpu.description, 'waiting...');
	});

	it('computes distro CPU as a share of the whole VM', () => {
		const monitor = new DistroMonitor('Ubuntu', () => undefined);
		feed(monitor, sample());
		feed(monitor, sample({ cpuTotal: 11_000, cpuIdle: 8_500, procJiffies: 550 }));

		// 50 of 1000 jiffies for the distro; 500 of 1000 idle for the VM.
		assert.equal(monitor.cpu.description, `${bar(0.05)} 5.0% · VM 50% of 8 cores`);
	});

	it('never reports negative CPU when processes exit between samples', () => {
		const monitor = new DistroMonitor('Ubuntu', () => undefined);
		feed(monitor, sample());
		feed(monitor, sample({ cpuTotal: 11_000, procJiffies: 100 }));
		assert.match(String(monitor.cpu.description), / 0\.0% · VM /);
	});

	it('keeps the previous CPU value when no time has passed', () => {
		const monitor = new DistroMonitor('Ubuntu', () => undefined);
		feed(monitor, sample());
		feed(monitor, sample({ cpuTotal: 11_000, procJiffies: 600 }));
		const before = monitor.cpu.description;
		feed(monitor, sample({ cpuTotal: 11_000, procJiffies: 700 }));
		assert.equal(monitor.cpu.description, before);
	});

	it('notifies with all three rows on every sample', () => {
		const updates: string[][] = [];
		const monitor = new DistroMonitor('Ubuntu', (items) => updates.push(items.map((i) => String(i.label))));
		feed(monitor, sample());
		assert.deepEqual(updates, [['CPU', 'Memory', 'Processes']]);
	});

	it('gives each row a stable id scoped to the distro', () => {
		const monitor = new DistroMonitor('Ubuntu', () => undefined);
		assert.deepEqual(
			monitor.items.map((i) => i.id),
			['distro/Ubuntu/metric/cpu', 'distro/Ubuntu/metric/memory', 'distro/Ubuntu/metric/procs'],
		);
	});
});

describe('metric rows', () => {
	it('carry no tooltip: each sample redraws the row, which would close it within seconds', () => {
		const monitor = new DistroMonitor('Ubuntu', () => undefined);
		feed(monitor, sample());
		feed(monitor, sample({ cpuTotal: 11_000, procJiffies: 550 }));
		assert.equal(monitor.cpu.tooltip, undefined);
		assert.equal(monitor.memory.tooltip, undefined);
	});
});
