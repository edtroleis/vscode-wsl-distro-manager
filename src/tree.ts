import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { DistroMonitor, formatBytes } from './monitor';
import {
	Distro,
	isCurrentWindowDistro,
	list,
	managedBy,
	readWslConfig,
	registryInfo,
	runtimeInfo,
	summarizeWslConfig,
	toHostPath,
	vmUptime,
	wslVersion,
} from './wsl';
import { clearPending, pendingSince, restartedSince } from './pending';
import { offerInteropRepair } from './interop';

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

let extensionUri: vscode.Uri | undefined;

/** Where the bundled icons live; set once on activation. */
export function setExtensionUri(uri: vscode.Uri): void {
	extensionUri = uri;
}

/**
 * The icon of a running distro, as a green SVG file. A ThemeIcon tinted with
 * charts.green lost its color whenever the view refreshed a row that kept its
 * id (every auto-refresh): VS Code updates the icon's shape but not its color.
 * A file icon carries its own color. One file per theme, in charts.green.
 */
export function runningIcon(managed: boolean): vscode.TreeItem['iconPath'] {
	if (!extensionUri) {
		return new vscode.ThemeIcon(managed ? 'package' : 'vm-active', new vscode.ThemeColor('charts.green'));
	}
	const name = managed ? 'managed-running' : 'distro-running';
	return {
		light: vscode.Uri.joinPath(extensionUri, 'resources', `${name}-light.svg`),
		dark: vscode.Uri.joinPath(extensionUri, 'resources', `${name}-dark.svg`),
	};
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

		const badges = [`WSL ${distro.version}`, distro.running ? vscode.l10n.t('Running') : vscode.l10n.t('Stopped')];
		if (managed) {
			badges.unshift(managed.tool);
		}
		if (distro.isDefault) {
			badges.unshift(vscode.l10n.t('default'));
		}
		if (isCurrentWindowDistro(distro.name)) {
			badges.unshift(vscode.l10n.t('this window'));
		}
		this.description = badges.join(' · ');

		this.iconPath = distro.running
			? runningIcon(!!managed)
			: new vscode.ThemeIcon(managed ? 'package' : 'vm-outline');

		const tooltip = new vscode.MarkdownString();
		tooltip.appendMarkdown(`**${distro.name}**\n\n`);
		const state = distro.running ? vscode.l10n.t('Running') : vscode.l10n.t('Stopped');
		tooltip.appendMarkdown(vscode.l10n.t('- State: {0}\n', state));
		tooltip.appendMarkdown(vscode.l10n.t('- Version: WSL {0}\n', distro.version));
		tooltip.appendMarkdown(vscode.l10n.t('- Default: {0}\n', distro.isDefault ? vscode.l10n.t('yes') : vscode.l10n.t('no')));
		if (managed) {
			tooltip.appendMarkdown(vscode.l10n.t('\nManaged by **{0}**. {1}\n', managed.tool, managed.hint));
		}
		this.tooltip = tooltip;

		const clickAction = vscode.workspace
			.getConfiguration('wslManager')
			.get<string>('clickAction', 'expand');
		if (clickAction === 'terminal') {
			this.command = {
				command: 'wslManager.openTerminal',
				title: vscode.l10n.t('Open Terminal'),
				arguments: [this],
			};
		} else if (clickAction === 'window') {
			this.command = {
				command: 'wslManager.openWindow',
				title: vscode.l10n.t('Open in New Window'),
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

/**
 * The VHDX only grows: space freed inside the distro stays allocated in the
 * file. Comparing its size with what the distro actually uses (known only while
 * it runs) shows how much a compaction would give back.
 */
export function vhdxItem(parent: DistroItem, vhdWindows: string, size: number, used: number | undefined): InfoItem {
	const reclaimable = estimateReclaimable(size, used);
	const value = reclaimable !== undefined ? vscode.l10n.t('{0} · ~{1} reclaimable', formatBytes(size), formatBytes(reclaimable)) : formatBytes(size);
	const lines = [vhdWindows, '', vscode.l10n.t('File size: {0}', formatBytes(size))];
	if (used === undefined) {
		lines.push(vscode.l10n.t('Start the distro to estimate reclaimable space.'));
	} else {
		lines.push(vscode.l10n.t('Used inside the distro: {0}', formatBytes(used)));
		if (reclaimable === undefined) {
			lines.push(vscode.l10n.t('Little to reclaim: compacting is not worth it now.'));
		}
	}
	const tooltip = lines.join('\n');
	const item = new InfoItem(parent, vscode.l10n.t('VHDX'), value, reclaimable !== undefined ? 'warning' : 'file-binary', tooltip);
	// Managed distros get no inline Compact button: their tool owns the disk.
	item.contextValue = parent.distro.version === 2 && !managedBy(parent.distro.name) ? 'wslVhdx' : 'wslInfo';
	return item;
}

/**
 * The first node of the view: what applies to WSL as a whole, not to one
 * distro. The global .wslconfig lives here instead of being repeated under
 * every distro, next to the WSL and kernel versions.
 */
export class GlobalItem extends vscode.TreeItem {
	constructor(expanded: boolean) {
		super('WSL', expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
		this.id = 'global';
		this.description = vscode.l10n.t('all distros');
		this.tooltip = vscode.l10n.t('Settings and versions that apply to WSL as a whole');
		this.iconPath = new vscode.ThemeIcon('server-environment');
		this.contextValue = 'wslGlobal';
	}
}

/**
 * The .wslconfig row; a click opens the file and the tooltip lists what is set.
 * While a saved change waits for WSL to restart, the row says so and offers the
 * restart inline.
 */
export function wslConfigItem(
	summary: string | undefined,
	exists: boolean,
	file: string,
	pending = false,
): vscode.TreeItem {
	// The file name says what it is; the row stays short, with the values in
	// the tooltip and only a state that needs attention in the description.
	const item = new vscode.TreeItem('.wslconfig', vscode.TreeItemCollapsibleState.None);
	item.id = 'global/wslconfig';
	item.description = pending
		? vscode.l10n.t('restart WSL to apply')
		: exists
			? undefined
			: vscode.l10n.t('not created');
	item.tooltip = [
		file,
		summary ?? (exists ? vscode.l10n.t('WSL defaults') : vscode.l10n.t('not created; WSL defaults')),
		'',
		pending
			? vscode.l10n.t('Saved changes are not applied yet: restart WSL (not Windows) to apply them.')
			: vscode.l10n.t('Changes apply to every distro after WSL restarts. Windows does not need to restart.'),
	].join('\n');
	item.iconPath = pending
		? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
		: new vscode.ThemeIcon('gear');
	item.contextValue = pending ? 'wslGlobalConfig.pending' : 'wslGlobalConfig';
	item.command = { command: 'wslManager.editWslConfig', title: vscode.l10n.t('Edit {0}', '.wslconfig') };
	return item;
}

export function wslVersionItem(version: { wsl: string; kernel?: string } | undefined): vscode.TreeItem {
	const item = new vscode.TreeItem(vscode.l10n.t('Version'), vscode.TreeItemCollapsibleState.None);
	item.id = 'global/version';
	item.description = version
		? version.kernel
			? vscode.l10n.t('WSL {0} · kernel {1}', version.wsl, version.kernel)
			: `WSL ${version.wsl}`
		: vscode.l10n.t('unknown (run "wsl --update")');
	item.iconPath = new vscode.ThemeIcon('info');
	item.contextValue = 'wslInfo';
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

	/** The WSL node starts expanded; remember when the user collapses it. */
	private collapsedGlobal = false;

	/** Running distros at the last refresh, to notice distros that stopped. */
	private lastRunning: Set<string> | undefined;

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
		if (element instanceof GlobalItem) {
			const [config, version, pending] = await Promise.all([
				readWslConfig().catch(() => undefined),
				wslVersion(),
				this.stillPending(),
			]);
			return [
				wslConfigItem(
					config && summarizeWslConfig(config.config),
					config?.exists ?? false,
					config?.path ?? '.wslconfig',
					pending,
				),
				wslVersionItem(version),
			];
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
			const items = distros
				.filter((d) => showManaged || !managedBy(d.name))
				.map((d) => new DistroItem(d, this.expanded.has(d.name)));
			// With no distros at all, show nothing so the welcome view (Install / Import) appears.
			if (distros.length === 0) {
				return [];
			}
			const hidden = distros.length - items.length;
			return [
				new GlobalItem(!this.collapsedGlobal),
				...items,
				...(items.length === 0
					? [new MessageItem(vscode.l10n.t('{0} Docker, Podman, or Rancher distros are hidden (wslManager.showManagedDistros).', hidden), 'eye-closed')]
					: []),
			];
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return [new MessageItem(vscode.l10n.t('Failed to query wsl.exe: {0}', message), 'error')];
		}
	}

	/**
	 * A distro that stops, for whatever reason (Stop, idle timeout), makes WSL
	 * remove Windows interop from every other running distro. When a refresh
	 * shows that a distro stopped, check (as the default user) and, if interop
	 * is gone, offer to repair it; nothing runs with privileges unless the user
	 * agrees and sudo allows it.
	 */
	private healInteropIfSomethingStopped(running: Set<string>): void {
		const previous = this.lastRunning;
		this.lastRunning = running;
		const stopped = previous ? [...previous].some((name) => !running.has(name)) : false;
		if (stopped && running.size > 0) {
			void offerInteropRepair([...running]).catch(() => undefined);
		}
	}

	/**
	 * Whether a saved .wslconfig still waits for WSL to restart. A running
	 * distro tells how long the VM has been up; if it booted after the save,
	 * the change is applied. With nothing running, it cannot tell, so it stays
	 * pending (the VM may still be up).
	 */
	private async stillPending(): Promise<boolean> {
		const savedAt = pendingSince();
		if (savedAt === undefined) {
			return false;
		}
		const running = [...(this.lastRunning ?? [])];
		if (running.length === 0) {
			return true;
		}
		const uptime = await vmUptime(running[0]).catch(() => undefined);
		if (uptime !== undefined && restartedSince(savedAt, uptime)) {
			await clearPending();
			return false;
		}
		return true;
	}

	/** Drops the details cache; used by the manual refresh. */
	invalidateDetails(): void {
		this.details.clear();
		void wslVersion(true);
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
				vscode.l10n.t('State'),
				distro.running ? vscode.l10n.t('Running') : vscode.l10n.t('Stopped'),
				distro.running ? 'pass-filled' : 'circle-large-outline',
			),
			...(distro.running ? this.monitorFor(distro.name).items : []),
			new InfoItem(item, vscode.l10n.t('Version'), vscode.l10n.t('WSL {0}', distro.version), 'versions'),
			new InfoItem(item, vscode.l10n.t('Default'), distro.isDefault ? vscode.l10n.t('yes') : vscode.l10n.t('no'), distro.isDefault ? 'star-full' : 'star-empty'),
		];

		if (runtime?.prettyName) {
			children.push(new InfoItem(item, vscode.l10n.t('OS'), runtime.prettyName, 'package'));
		} else if (registry?.flavor) {
			const os = [registry.flavor, registry.osVersion].filter(Boolean).join(' ');
			children.push(new InfoItem(item, vscode.l10n.t('OS'), os, 'package'));
		}
		if (runtime?.kernel) {
			children.push(new InfoItem(item, vscode.l10n.t('Kernel'), runtime.kernel, 'chip'));
		}
		if (runtime?.user) {
			children.push(new InfoItem(item, vscode.l10n.t('Default user'), runtime.user, 'account'));
		} else if (registry?.defaultUid !== undefined) {
			const uid = registry.defaultUid === 0 ? vscode.l10n.t('root (uid 0)') : vscode.l10n.t('uid {0}', registry.defaultUid);
			children.push(new InfoItem(item, vscode.l10n.t('Default user'), uid, 'account'));
		}
		if (runtime?.diskUsed !== undefined && runtime.diskSize !== undefined) {
			children.push(
				new InfoItem(
					item,
					vscode.l10n.t('Disk (/)'),
					vscode.l10n.t('{0} used of {1}', formatBytes(runtime.diskUsed), formatBytes(runtime.diskSize)),
					'database',
				),
			);
		}
		if (registry?.basePath) {
			children.push(new InfoItem(item, vscode.l10n.t('Location'), registry.basePath, 'folder'));
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
				if (e.element instanceof GlobalItem) {
					this.collapsedGlobal = false;
				}
				if (e.element instanceof DistroItem) {
					this.expanded.add(e.element.distro.name);
					this.startMonitor(e.element.distro);
				}
			}),
			view.onDidCollapseElement((e) => {
				if (e.element instanceof GlobalItem) {
					this.collapsedGlobal = true;
				}
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
