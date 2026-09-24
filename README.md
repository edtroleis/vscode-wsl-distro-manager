# WSL Distro Manager

[![CI](https://img.shields.io/github/actions/workflow/status/edtroleis/vscode-wsl-distro-manager/ci.yml?branch=main&label=CI)](https://github.com/edtroleis/vscode-wsl-distro-manager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Manage your Windows Subsystem for Linux distros from the VS Code sidebar. Start
and stop them, watch their CPU and memory, install, move, and back them up,
reclaim disk space, and edit their configuration, without leaving the editor.

![The WSL Distro Manager view with the default distro expanded: live CPU, memory, and process count, OS and disk details, and about 8.4 GB of reclaimable disk space. Podman distros are labeled.](images/overview.png)

WSL Distro Manager complements Microsoft's **WSL** extension
([`ms-vscode-remote.remote-wsl`](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-wsl)),
which connects VS Code to a distro. This extension manages the distros
themselves.

## Features

**See every distro at a glance**
- State, WSL version, and default distro, refreshed automatically.
- Expand a distro for its OS, kernel, default user, disk usage, install
  location, and virtual disk (VHDX) size.
- Live CPU, memory, and process count for running distros.

**Control them**
- Start, stop, and restart. A started distro stays running until you stop it;
  WSL would otherwise stop it about 15 seconds later.
- Open a terminal, or a new VS Code window connected to the distro.
- Set the default distro, convert between WSL 1 and WSL 2, or shut down WSL.

**Install, move, and back up**
- Install distros from the official online catalog, with the name and location
  you choose.
- Export and import (`.tar` or `.vhdx`), with progress and cancel.
- Move a distro's disk to another folder or drive.
- Back up chosen folders to a `.tar.gz` or `.zip` on Windows, and send Windows
  files into a distro, restoring backups in place.

**Reclaim disk space**
- See how much space a distro's virtual disk holds beyond what it uses, and
  compact it to give that space back to Windows.

**Configure**
- Edit a distro's `/etc/wsl.conf` (saved as root) and the global `.wslconfig`.
  On save, the extension offers the step that applies the change.

Every action is one right-click away:

![Context menu of a distro: open in a new window or terminal; stop and restart; set as default, edit wsl.conf, convert; export, compact disk, move; back up folders, send files; copy name; unregister.](images/context-menu.png)

**Stay safe**
- Destructive actions ask first; unregistering requires typing the distro name.
- Actions that would disconnect a VS Code window from WSL are refused or
  confirmed explicitly.
- Distros owned by Docker Desktop, Podman, or Rancher Desktop are labeled and
  protected.
- Repairs Windows interop when WSL removes it (see
  [Troubleshooting](#troubleshooting)).

## Requirements

- Windows 10 or 11 with WSL installed. Tested with WSL 2.7.
- VS Code 1.85 or later.
- *Install Distro* and *Move to Another Folder* need a recent WSL. Run
  `wsl --update` if they fail.
- *Open in New VS Code Window* needs Microsoft's WSL extension.

## Getting started

1. Install **WSL Distro Manager** from the Marketplace.
2. Click the **WSL Distro Manager** icon in the activity bar.
3. Click a distro to expand it. Right-click it for every action, or use the
   buttons on its row.

Every action is also in the Command Palette (`Ctrl+Shift+P`), under
**WSL Distro Manager**.

## Guides

### Reclaim disk space

A WSL 2 distro stores its files in a virtual disk (VHDX) that grows but never
shrinks on its own: space freed inside the distro stays allocated on your
Windows drive. When a running distro is expanded, its **VHDX** row shows the
space a compaction would give back, next to a **Compact Disk** button.

![The VHDX row shows 52.8 GB with about 9.9 GB reclaimable, and the Compact Disk confirmation.](images/compact.png)

The estimate appears only when compaction is worth it: at least 2 GB and 10% of
the space in use. A virtual disk always holds some file system overhead, so a
smaller gap gives back almost nothing. The confirmation repeats the expected
gain, or warns when there is little to reclaim.

Compaction stops the distro, asks Windows for administrator permission (UAC) to
run `diskpart`, then starts the distro again. Current WSL versions keep every
distro's disk attached while *any* distro is running. In that case the
extension asks to shut WSL down, lists the running distros, and starts them
again afterwards.

![Confirmation to shut down WSL for the compaction, listing the running distros that will be restarted.](images/compact-shutdown.png)

A shutdown disconnects every VS Code window connected to WSL, and those windows
do not always reconnect. **Compaction therefore refuses to run while a VS Code
window is connected to WSL.** It changes nothing and names the windows to
close. Close them, then run *Compact Disk* from a local VS Code window. A 50 GB
disk takes a few minutes; the notification shows the elapsed time.

![Progress notification: running diskpart, 0m 14s elapsed.](images/compact-progress.png)

### Back up folders and restore them

**Back Up Folders...** archives the folders and files you choose, without
exporting the whole distro:

1. Pick entries of your home folder from the list, or type paths (relative to
   your home, or absolute).
2. Choose the format. `.tar.gz` is recommended: it keeps Linux permissions and
   symbolic links. `.zip` opens anywhere but loses them, so restored scripts are
   no longer executable.
3. Review the names to leave out. `node_modules`, `.venv`, `venv`,
   `__pycache__`, `.cache`, and `target` are excluded by default.
4. Choose where to save it: your Windows **Desktop** (also when it is redirected
   to OneDrive), the folder in `wslManager.backupFolder`, or any other folder.

The backup runs inside the distro as your user. Files you cannot read are left
out, and the result tells you so.

To restore, use **Send Files to Distro...**, send the archive to the folder it
came from (usually `~`), and choose **Send and extract**.

### Send files into a distro

**Send Files to Distro...** copies files from Windows into a folder of the
distro, `~` by default. It runs as your user and never uses `sudo`: if the
folder needs more permissions, it says so and changes nothing. Before copying,
it asks whether to overwrite or skip files that already exist, and whether to
extract `.tar.gz` or `.zip` archives.

### Install, move, export, and import

- **Install Distro...** lists the online catalog. After installing, open a
  terminal in the new distro to create its default user.
- **Move to Another Folder...** moves the distro's virtual disk, for example to
  another drive. Like compaction, it needs the disk released, so the same rules
  about shutting WSL down apply.
- **Export** and **Import** show progress and can be cancelled. A cancelled
  export deletes its partial file, and a cancelled import leaves nothing
  behind.

### Distros managed by other tools

Distros created by **Docker Desktop** (`docker-desktop`, `docker-desktop-data`),
**Podman** (`podman-*`), and **Rancher Desktop** show the tool's name.
Configuration actions are hidden for them, and stopping or unregistering one
warns first, because doing it from here can break that tool. Set
`wslManager.showManagedDistros` to `false` to hide them.

## Settings

| Setting | Default | Description |
|---|---|---|
| `wslManager.clickAction` | `expand` | What clicking a distro does: `expand`, `terminal`, `window`, or `none`. |
| `wslManager.autoRefreshSeconds` | `10` | Refresh interval while the view is visible. `0` turns it off. |
| `wslManager.metricsIntervalSeconds` | `2` | CPU and memory sampling interval for an expanded distro. |
| `wslManager.showManagedDistros` | `true` | Show Docker Desktop, Podman, and Rancher Desktop distros. |
| `wslManager.backupFolder` | *(empty)* | Folder offered first for backups. Empty means the Windows Desktop. |
| `wslManager.backupExcludes` | `node_modules`, `.venv`, ... | Names left out of backups, at any depth. |
| `wslManager.defaultUser` | *(empty)* | User for new terminals. Empty means the distro's default user. |
| `wslManager.confirmDestructiveActions` | `true` | Confirm before stopping, shutting down, or unregistering. |
| `wslManager.wslExePath` | *(empty)* | Path to `wsl.exe`. Empty means detect it automatically. |

## Known limitations

- **Compacting or moving a disk needs WSL shut down** on current WSL versions,
  which closes every WSL terminal. The extension refuses while VS Code windows
  are connected to WSL rather than disconnect them.
- **Memory is an estimate.** It adds up the memory of each process, so memory
  shared between processes counts more than once.
- **Started distros keep running** until you stop them, even after VS Code
  closes. This is what *Start* is for, but it keeps the WSL VM using memory.
- **Live metrics keep an expanded distro running.** Collapse it, or hide the
  view, to let WSL stop it.

## Troubleshooting

**`.exe` files stop working inside a distro ("Exec format error").**
When a distro stops, WSL removes Windows interop from every other running
distro. The extension restores it automatically after its own actions and when
it notices a distro stopped. To restore it on demand, run **Repair Windows
Interop** from the view's `...` menu. From inside the distro:

```bash
sudo sh -c "echo :WSLInterop:M::MZ::/init:P > /proc/sys/fs/binfmt_misc/register"
```

**A VS Code window connected to WSL shows "Failed to connect to the remote
extension host server".** WSL was shut down, for example by *Shut Down WSL*.
Run **Developer: Reload Window** in that window.

**Installing a downloaded `.vsix` fails with "UNC host 'wsl.localhost' access
is not allowed".** VS Code on Windows does not open files inside a distro.
Copy the `.vsix` to a Windows folder first.

**The view is empty or shows an error.** Check that `wsl.exe --list` works in a
terminal. If `wsl.exe` is not on the `PATH`, set `wslManager.wslExePath`.

## Privacy

The extension collects no telemetry and makes no network requests. Installing
a distro and listing the catalog go through `wsl.exe`, which downloads from
Microsoft. Live metrics are shared between VS Code windows through files in
`%TEMP%\wsl-distro-manager`.

## Languages

English and Brazilian Portuguese. The extension follows the VS Code display
language (**Configure Display Language**).

## Contributing

Bug reports and pull requests are welcome on
[GitHub](https://github.com/edtroleis/vscode-wsl-distro-manager/issues). See
[CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the extension works
around WSL's quirks.

## License

[MIT](LICENSE)
