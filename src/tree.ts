import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { DistroMonitor, formatBytes } from './monitor';
import { Distro, isCurrentWindowDistro, list, managedBy, registryInfo, restoreInterop, runtimeInfo, toHostPath } from './wsl';

/**
 * How much a compaction would likely give back, or undefined when it is not
 * worth a WSL shutdown. The VHDX always holds a bit more than `df` reports as
 * used (ext4 metadata, journal, reserved blocks), so a small gap is not free
 * space: in tests, a 1.2 GB gap on 43 GB used reclaimed 23 MB and a 1.9 GB gap
 * on 16 GB reclaimed 0.2 GB, while a 9.9 GB gap on 43 GB reclaimed 8.7 GB.
 * Hence the bar: at least 2 GB and 10% of the used space.
 */
export function estimateReclaimable(vhdxSize: number, used: number | undefined): number | undefined {
	if (used === undefined) {
		return undefined;
	}
	const gap = vhdxSize - used;
	return gap >= Math.max(2 * 1024 ** 3, used * 0.1) ? gap : undefined;
}

export class DistroItem extends vscode.TreeItem {
	constructor(readonly distro: Distro, expanded = false) {
		super(
			distro.name,
			expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
		);
		// The id is stable across refreshes (keeping selection and expansion) but
		// changes with the state: for an existing id VS Code updates the icon shape
		// and not its color, so a distro that started stayed gray. The provider
		// restores expansion across that change.
		this.id = `distro/${distro.name}/${distro.running ? 'running' : 'stopped'}`;

		// "wslDistro.<state>[.managed]": menus hide config actions on managed distros.
		const managed = managedBy(distro.name);
		this.contextValue = `wslDistro.${distro.running ? 'running' : 'stopped'}${managed ? '.managed' : ''}`;

		const badges = [`WSL ${distro.version}`, distro.running ? 'Running' : 'Stopped'];
		if (managed) {
			badges.unshift(managed.tool);
		}
		if (distro.isDefault) {
			badges.unshift('default');
		}
		if (isCurrentWindowDistro(distro.name)) {
			badges.unshift('this window');
		}
		this.description = badges.join(' · ');

		const icon = managed ? 'package' : distro.running ? 'vm-active' : 'vm-outline';
		this.iconPath = distro.running
			? new vscode.ThemeIcon(icon, new vscode.ThemeColor('charts.green'))
			: new vscode.ThemeIcon(icon);

		const tooltip = new vscode.MarkdownString();
		tooltip.appendMarkdown(`**${distro.name}**\n\n`);
		tooltip.appendMarkdown(`- State: ${distro.running ? 'Running' : 'Stopped'}\n`);
		tooltip.appendMarkdown(`- Version: WSL ${distro.version}\n`);
		tooltip.appendMarkdown(`- Default: ${distro.isDefault ? 'yes' : 'no'}\n`);
		if (managed) {
			tooltip.appendMarkdown(`\nManaged by **${managed.tool}**. ${managed.hint}\n`);
		}
		this.tooltip = tooltip;

		const clickAction = vscode.workspace
			.getConfiguration('wslManager')
			.get<string>('clickAction', 'expand');
		if (clickAction === 'terminal') {
			this.command = {
				command: 'wslManager.openTerminal',
				title: 'Open Terminal',
				arguments: [this],
			};
		} else if (clickAction === 'window') {
			this.command = {
				command: 'wslManager.openWindow',
				title: 'Open in New Window',
				arguments: [this],
			};
		}
	}
}

/** A "label: value" row inside an expanded distro. */
export class InfoItem extends vscode.TreeItem {
	constructor(
		readonly parent: DistroItem,
		label: string,
		value: string,
		icon: string,
		tooltip?: string,
	) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.id = `${parent.id}/info/${label}`;
		this.description = value;
		this.tooltip = tooltip ?? `${label}: ${value}`;
		this.iconPath = new vscode.ThemeIcon(icon);
		this.contextValue = 'wslInfo';
	}
}

class ConfigFileItem extends vscode.TreeItem {
	constructor(parent: DistroItem, label: string, description: string, command: string) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.id = `${parent.id}/config/${label}`;
		this.description = description;
		this.iconPath = new vscode.ThemeIcon('gear');
		this.contextValue = 'wslConfigFile';
		this.command = { command, title: `Edit ${label}`, arguments: [parent] };
	}
}

/**
 * The VHDX only grows: space freed inside the distro stays allocated in the
 * file. Comparing its size with what the distro actually uses (known only while
 * it runs) shows how much a compaction would give back.
 */
export function vhdxItem(parent: DistroItem, vhdWindows: string, size: number, used: number | undefined): InfoItem {
	const reclaimable = estimateReclaimable(size, used);
	const value = reclaimable !== undefined ? `${formatBytes(size)} · ~${formatBytes(reclaimable)} reclaimable` : formatBytes(size);
	const tooltip =
		`${vhdWindows}\n\nFile size: ${formatBytes(size)}` +
		(used === undefined
			? '\nStart the distro to estimate reclaimable space.'
			: `\nUsed inside the distro: ${formatBytes(used)}` +
				(reclaimable === undefined ? '\nLittle to reclaim: compacting is not worth it now.' : ''));
	const item = new InfoItem(parent, 'VHDX', value, reclaimable !== undefined ? 'warning' : 'file-binary', tooltip);
	// Managed distros get no inline Compact button: their tool owns the disk.
	item.contextValue = parent.distro.version === 2 && !managedBy(parent.distro.name) ? 'wslVhdx' : 'wslInfo';
	return item;
}

class MessageItem extends vscode.TreeItem {
	constructor(message: string, icon: string) {
		super(message, vscode.TreeItemCollapsibleState.None);
		this.iconPath = new vscode.ThemeIcon(icon);
		this.contextValue = 'wslMessage';
	}
}

export class DistroTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly changed = new vscode.EventEmitter<vscode.TreeItem | vscode.TreeItem[] | void>();
	readonly onDidChangeTreeData = this.changed.event;

	private readonly loaded = new vscode.EventEmitter<Distro[]>();
	/** Fired on every successful load, for anyone mirroring the state (badge, etc.). */
	readonly onDidLoad = this.loaded.event;

	private timer: NodeJS.Timeout | undefined;
	private visible = false;

	/**
	 * Auto-refresh rebuilds the children of every expanded distro; without a cache
	 * that would run reg.exe and wsl --exec every few seconds.
	 */
	private readonly details = new Map<string, { key: string; at: number; items: Promise<vscode.TreeItem[]> }>();
	private static readonly DETAILS_TTL_MS = 30_000;

	/**
	 * One monitor per running distro. The MetricItems are the same instances across
	 * refreshes, so each sample updates only those rows via changed.fire(item).
	 */
	private readonly monitors = new Map<string, DistroMonitor>();

	/** Expanded distros by name, since a state change gives the item a new id. */
	private readonly expanded = new Set<string>();

	/** Running distros at the last refresh, to notice distros that stopped. */
	private lastRunning: Set<string> | undefined;
	private restoringInterop = false;

	refresh(): void {
		this.changed.fire();
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
		if (element instanceof DistroItem) {
			return this.distroChildren(element);
		}
		if (element) {
			return [];
		}
		try {
			const distros = await list();
			this.loaded.fire(distros);
			const running = new Set(distros.filter((d) => d.running).map((d) => d.name));
			this.stopMonitorsExcept(running);
			this.healInteropIfSomethingStopped(running);
			const showManaged = vscode.workspace
				.getConfiguration('wslManager')
				.get<boolean>('showManagedDistros', true);
			return distros
				.filter((d) => showManaged || !managedBy(d.name))
				.map((d) => new DistroItem(d, this.expanded.has(d.name)));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return [new MessageItem(`Failed to query wsl.exe: ${message}`, 'error')];
		}
	}

	/**
	 * A distro that stops, for whatever reason (Stop, idle timeout), takes
	 * Windows interop away from every other running distro. When a refresh
	 * shows that a distro stopped, re-register it in the ones still running.
	 */
	private healInteropIfSomethingStopped(running: Set<string>): void {
		const previous = this.lastRunning;
		this.lastRunning = running;
		const stopped = previous ? [...previous].some((name) => !running.has(name)) : false;
		if (!stopped || running.size === 0 || this.restoringInterop) {
			return;
		}
		this.restoringInterop = true;
		restoreInterop([...running])
			.then((restored) => {
				if (restored.length > 0) {
					vscode.window.setStatusBarMessage(`$(check) Restored Windows interop in ${restored.join(', ')}`, 8000);
				}
			})
			.catch(() => undefined)
			.finally(() => (this.restoringInterop = false));
	}

	/** Drops the details cache; used by the manual refresh. */
	invalidateDetails(): void {
		this.details.clear();
	}

	private monitorFor(name: string): DistroMonitor {
		let monitor = this.monitors.get(name);
		if (!monitor) {
			monitor = new DistroMonitor(name, (items) => this.changed.fire(items));
			this.monitors.set(name, monitor);
		}
		return monitor;
	}

	/** Only monitors a distro that is already running while the view is visible: the process keeps the distro alive. */
	private startMonitor(distro: Distro): void {
		if (distro.running && this.visible) {
			this.monitorFor(distro.name).start();
		}
	}

	private stopMonitorsExcept(keep: Set<string>): void {
		for (const [name, monitor] of this.monitors) {
			if (!keep.has(name)) {
				monitor.dispose();
				this.monitors.delete(name);
			}
		}
	}

	private distroChildren(item: DistroItem): Promise<vscode.TreeItem[]> {
		const { distro } = item;
		this.startMonitor(distro);
		const key = `${distro.running}/${distro.version}/${distro.isDefault}`;
		const cached = this.details.get(distro.name);
		if (cached && cached.key === key && Date.now() - cached.at < DistroTreeProvider.DETAILS_TTL_MS) {
			return cached.items;
		}
		const items = this.loadDistroChildren(item);
		this.details.set(distro.name, { key, at: Date.now(), items });
		items.catch(() => this.details.delete(distro.name));
		return items;
	}

	private async loadDistroChildren(item: DistroItem): Promise<vscode.TreeItem[]> {
		const { distro } = item;
		const [registry, runtime] = await Promise.all([
			registryInfo()
				.then((all) => all.get(distro.name))
				.catch(() => undefined),
			// Never query a stopped distro: any wsl -d would boot it.
			distro.running ? runtimeInfo(distro.name).catch(() => undefined) : Promise.resolve(undefined),
		]);

		const children: vscode.TreeItem[] = [
			new InfoItem(
				item,
				'State',
				distro.running ? 'Running' : 'Stopped',
				distro.running ? 'pass-filled' : 'circle-large-outline',
			),
			...(distro.running ? this.monitorFor(distro.name).items : []),
			new InfoItem(item, 'Version', `WSL ${distro.version}`, 'versions'),
			new InfoItem(item, 'Default', distro.isDefault ? 'yes' : 'no', distro.isDefault ? 'star-full' : 'star-empty'),
		];

		if (runtime?.prettyName) {
			children.push(new InfoItem(item, 'OS', runtime.prettyName, 'package'));
		} else if (registry?.flavor) {
			const os = [registry.flavor, registry.osVersion].filter(Boolean).join(' ');
			children.push(new InfoItem(item, 'OS', os, 'package'));
		}
		if (runtime?.kernel) {
			children.push(new InfoItem(item, 'Kernel', runtime.kernel, 'chip'));
		}
		if (runtime?.user) {
			children.push(new InfoItem(item, 'Default user', runtime.user, 'account'));
		} else if (registry?.defaultUid !== undefined) {
			const uid = registry.defaultUid === 0 ? 'root (uid 0)' : `uid ${registry.defaultUid}`;
			children.push(new InfoItem(item, 'Default user', uid, 'account'));
		}
		if (runtime?.diskUsed !== undefined && runtime.diskSize !== undefined) {
			children.push(
				new InfoItem(
					item,
					'Disk (/)',
					`${formatBytes(runtime.diskUsed)} used of ${formatBytes(runtime.diskSize)}`,
					'database',
				),
			);
		}
		if (registry?.basePath) {
			children.push(new InfoItem(item, 'Location', registry.basePath, 'folder'));
			if (registry.vhdFileName) {
				const vhdWindows = path.win32.join(registry.basePath, registry.vhdFileName);
				const size = await toHostPath(vhdWindows)
					.then((p) => fs.stat(p))
					.then((st) => st.size)
					.catch(() => undefined);
				if (size !== undefined) {
					children.push(vhdxItem(item, vhdWindows, size, runtime?.diskUsed));
				}
			}
		}

		children.push(
			new ConfigFileItem(item, '/etc/wsl.conf', 'this distro', 'wslManager.editWslConf'),
			new ConfigFileItem(item, '.wslconfig', 'global (all distros)', 'wslManager.editWslConfig'),
		);
		return children;
	}

	/** Only polls while the view is visible, so WSL is not woken up for nothing. */
	bindVisibility(view: vscode.TreeView<vscode.TreeItem>): vscode.Disposable {
		this.visible = view.visible;
		this.rescheduleTimer();
		const subscriptions = [
			view.onDidChangeVisibility((e) => {
				this.visible = e.visible;
				this.rescheduleTimer();
				if (e.visible) {
					this.refresh();
				} else {
					for (const monitor of this.monitors.values()) {
						monitor.stop();
					}
				}
			}),
			// Re-expanding an already loaded node does not call getChildren again.
			view.onDidExpandElement((e) => {
				if (e.element instanceof DistroItem) {
					this.expanded.add(e.element.distro.name);
					this.startMonitor(e.element.distro);
				}
			}),
			view.onDidCollapseElement((e) => {
				if (e.element instanceof DistroItem) {
					this.expanded.delete(e.element.distro.name);
					this.monitors.get(e.element.distro.name)?.stop();
				}
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('wslManager.autoRefreshSeconds')) {
					this.rescheduleTimer();
				}
				if (e.affectsConfiguration('wslManager.metricsIntervalSeconds')) {
					for (const monitor of this.monitors.values()) {
						if (monitor.active) {
							monitor.stop();
							monitor.start();
						}
					}
				}
				if (
					e.affectsConfiguration('wslManager.clickAction') ||
					e.affectsConfiguration('wslManager.showManagedDistros')
				) {
					this.refresh();
				}
			}),
			new vscode.Disposable(() => {
				this.clearTimer();
				this.stopMonitorsExcept(new Set());
			}),
		];
		return vscode.Disposable.from(...subscriptions);
	}

	private rescheduleTimer(): void {
		this.clearTimer();
		const seconds = vscode.workspace
			.getConfiguration('wslManager')
			.get<number>('autoRefreshSeconds', 10);
		if (!this.visible || !seconds || seconds <= 0) {
			return;
		}
		this.timer = setInterval(() => this.refresh(), seconds * 1000);
	}

	private clearTimer(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}
