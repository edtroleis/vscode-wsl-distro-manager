# WSL Distro Manager

Manage your WSL distros from the VS Code sidebar: lifecycle, live CPU and
memory, default distro, backups, and editing of the configuration files.

It does not replace the official **WSL** extension (`ms-vscode-remote.remote-wsl`),
which is still what connects VS Code to a distro. This one covers what the
official extension does not: start/stop, `--set-default`, export/import,
`--shutdown`, resource monitoring, and editing `.wslconfig` and `/etc/wsl.conf`.

<!-- Screenshots: capture them as described in TESTING.md, then uncomment.

![WSL Distro Manager view with an expanded distro showing live CPU and memory](images/overview.png)

-->

## Features

| Action | WSL command behind it |
|---|---|
| List distros with state, version, and default | `wsl -l -q`, `wsl -l --running -q`, `wsl -l -v` |
| Details on expand: OS, kernel, user, disk, location, VHDX size | registry `HKCU\...\Lxss`; `wsl -d <d> -e sh` only if the distro is already running |
| Live CPU, memory, and process count (expanded, running distro) | `sh` loop over `/proc` via `wsl -d <d> -e` |
| Compact the VHDX to reclaim disk space | `fstrim`, `wsl --terminate`, then `diskpart compact vdisk` (UAC prompt) |
| Start / Stop / Restart | `wsl -d <d> -e /bin/true`, `wsl --terminate <d>` |
| Set default distro | `wsl --set-default <d>` |
| Convert WSL 1 ⇄ WSL 2 | `wsl --set-version <d> <n>` |
| Export / Import (`.tar` or `.vhdx`) | `wsl --export` / `wsl --import` |
| Unregister a distro | `wsl --unregister <d>` |
| Shut down WSL | `wsl --shutdown` |
| Open a terminal (default user or root) | `wsl -d <d> [-u <user>]` |
| Open a new connected window | authority `wsl+<d>` |
| Edit the distro's `/etc/wsl.conf` | `wsl -d <d> -u root` |
| Edit the global `.wslconfig` | `%USERPROFILE%\.wslconfig` |

Destructive actions (stop, shut down, convert) ask for confirmation;
`unregister` requires typing the distro name. Actions that would disconnect the
current VS Code window always ask, even with confirmations turned off.

### Reclaiming disk space

A WSL 2 distro keeps its files in a VHDX that grows but never shrinks on its own:
space freed inside the distro stays allocated on the Windows drive. When a
running distro is expanded, the **VHDX** row shows how much a compaction would
give back, with an inline **Compact Disk** button.

Compacting stops the distro, asks Windows for administrator permission (UAC) to
run `diskpart`, and starts the distro again if it was running.

Current WSL versions keep **every** distro's disk attached to the WSL VM while
any distro is running, even disks of distros that have stopped. When that is the
case, the extension lists the running distros and asks to shut WSL down; after
compacting, it starts them again (except Docker/Podman/Rancher distros, which
must be started from their tool).

The shutdown disconnects **every** VS Code window and terminal connected to WSL.
Run compaction from a local VS Code window and wait for the result before
reconnecting: `diskpart` reports no progress, and a 50 GB disk takes a few minutes
(the notification shows the elapsed time).

### Distros managed by other tools

Distros created by **Docker Desktop** (`docker-desktop`, `docker-desktop-data`),
**Podman** (`podman-*`), and **Rancher Desktop** are labeled with the tool's name.
Configuration actions are hidden for them, and stopping or unregistering one always
warns first, since doing so from here can break that tool. Set
`wslManager.showManagedDistros` to `false` to hide them.

After saving `wsl.conf` or `.wslconfig`, the extension offers the step that
applies it: restarting the distro or running `wsl --shutdown`.

## Settings

| Key | Default | Description |
|---|---|---|
| `wslManager.clickAction` | `expand` | What clicking a distro does: `expand` (details), `terminal`, `window`, or `none`. |
| `wslManager.showManagedDistros` | `true` | Show Docker Desktop, Podman, and Rancher Desktop distros. |
| `wslManager.metricsIntervalSeconds` | `2` | CPU/memory sampling interval for an expanded distro. |
| `wslManager.autoRefreshSeconds` | `10` | Automatic refresh while the view is visible. `0` disables it. |
| `wslManager.defaultUser` | `""` | User for opened terminals. Empty = the distro's default. |
| `wslManager.wslExePath` | `""` | Path to `wsl.exe`. Empty = auto-detect. |
| `wslManager.confirmDestructiveActions` | `true` | Confirm before terminate/shutdown/unregister. |

## Requirements

Windows 10/11 with WSL installed. The extension also works from a VS Code
window connected to a WSL distro; it then calls `wsl.exe` through interop.

## Implementation notes

WSL pitfalls the extension handles explicitly:

**1. Encoding.** `wsl.exe` writes **UTF-16LE without a BOM**, and `WSL_UTF8=1` is
ignored by several builds (confirmed on WSL 2.7.14). Reading it as UTF-8 yields a
`\0` between every character. `decode()` in [`src/wsl.ts`](src/wsl.ts) checks for a
BOM and, failing that, for the NUL byte pattern.

**2. Localized `STATE` column.** On non-English Windows the state is translated
and may contain spaces, so slicing `wsl -l -v` by column position breaks. Names
come from `-l -q` and state from `-l --running -q`; from the verbose output only
the `*` marker and the last token (always the numeric version) are used.

**3. `/etc/wsl.conf` requires root.** The `\\wsl.localhost` share accesses the
distro as the default user, so writing to `/etc` fails with *permission denied*.
The extension registers a `FileSystemProvider` on the `wsl-config:` scheme that
reads and writes through `wsl -d <d> -u root`, normalizing CRLF → LF on save. The
distro name goes in the URI *path*, never the *authority*: VS Code lowercases the
authority, and names like `FedoraLinux-43` and `fedora-linux-43` can coexist.

**4. Which host the extension runs on.** `extensionKind` is `["ui", "workspace"]`:
preferably on the Windows host, falling back to the remote host. `["ui"]` alone
would prevent developing from a window connected to WSL, since the Windows host
does not load an extension that lives on the Linux filesystem.

With the fallback both hosts work, but each path moves:

| | Windows host | remote host (WSL) |
|---|---|---|
| `wsl.exe` | `wsl.exe` on PATH | `/mnt/c/Windows/System32/wsl.exe` (interop) |
| `.wslconfig` | `os.homedir()` | `cmd.exe /c echo %USERPROFILE%` + `wslpath -u` |
| terminal shell | `wsl.exe` | chosen by `vscode.env.remoteName` |

**5. Per-distro metrics.** On WSL 2 every distro shares one VM but has its own
PID namespace, so summing `/proc/<pid>/stat` inside a distro gives that distro's
usage. One long-lived `sh` loop per expanded distro streams samples instead of
spawning `wsl.exe` on every tick. Memory is the sum of process RSS, so shared
pages are counted more than once.

**6. Interop can vanish.** When a distro that uses systemd stops, its
`systemd-binfmt` unregisters the `WSLInterop` binfmt entry, and since all distros
share one kernel, every other running distro loses the ability to run `.exe`
files. Running `wsl.exe` then fails with shell errors instead of a clear message.
When the extension runs inside WSL and this happens, it reports the problem and
the one-line fix (re-registering `WSLInterop`).

## Development

```bash
npm install
npm run watch   # or: npm run compile
```

Open the folder in VS Code and press **F5** to launch the Extension Development
Host. The **WSL Distro Manager** icon appears in the activity bar of the new window.

If it does not, run `Developer: Show Running Extensions` in the development
window to check whether `wsl-distro-manager` loaded, and `Help > Toggle Developer
Tools` for activation errors. After recompiling, reload the development window
with `Ctrl+R`.

Unit tests use the built-in Node.js test runner (Node 22+) with a minimal mock of
the `vscode` module, so they run without launching VS Code:

```bash
npm test
```

They cover the parsing of `wsl.exe`, `reg.exe`, and sampling output, path
conversion, current-window detection, managed-distro detection, and the
CPU/memory math. Fixtures are real `wsl.exe` output, including UTF-16LE without a
BOM and a localized `STATE` column.

A read-only smoke test calls the real functions against your WSL installation.
From a WSL shell, `smoke:windows` also runs it (and the unit tests) on the
Windows host, using the Node.js runtime bundled with VS Code:

```bash
npm run smoke            # on this host
npm run smoke:windows    # on the Windows host, from WSL
```

See [TESTING.md](TESTING.md) for the manual checklist before a release.

To package:

```bash
npm run package
```

## License

[MIT](LICENSE)
