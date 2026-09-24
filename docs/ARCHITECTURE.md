# Architecture

How WSL Distro Manager is organized, and the WSL behaviors it works around.
Most of these were found by testing against a real installation (WSL 2.7.14,
Windows 11); each section says what goes wrong without the workaround.

## Modules

| File | Responsibility |
|---|---|
| [`src/extension.ts`](../src/extension.ts) | Activation: registers the view, the commands, and the `wsl-config:` file system; offers to apply config changes on save. |
| [`src/tree.ts`](../src/tree.ts) | The sidebar tree: distro rows, expandable details, the VHDX row, refresh timer, interop healing. |
| [`src/commands.ts`](../src/commands.ts) | Lifecycle, export/import, install, move, compaction, and their confirmations. |
| [`src/transfer.ts`](../src/transfer.ts) | Folder backups and sending files into a distro. |
| [`src/monitor.ts`](../src/monitor.ts) | Live CPU and memory, shared between VS Code windows. |
| [`src/wsl.ts`](../src/wsl.ts) | Everything that runs `wsl.exe`, `reg.exe`, PowerShell, or `diskpart`, plus the parsers for their output. |
| [`src/configFs.ts`](../src/configFs.ts) | File system provider that reads and writes `/etc/wsl.conf` as root and `.wslconfig` on Windows. |
| [`src/progress.ts`](../src/progress.ts), [`src/prompts.ts`](../src/prompts.ts) | Progress notifications and text prompts with a Confirm button. |

Parsing is kept in pure functions (`parseDistroList`, `parseRegistry`,
`parseSample`, ...) so the unit tests can exercise them with real output and no
processes.

## Where the extension runs

`extensionKind` is `["ui", "workspace"]`: VS Code runs the extension on the
Windows host when it can, and inside WSL otherwise (for example while developing
it from a window connected to WSL). `["ui"]` alone would make the extension
invisible there, because the Windows host does not load extensions stored in a
Linux file system.

Paths and programs differ between the two hosts:

| | Windows host | Inside WSL |
|---|---|---|
| `wsl.exe`, `reg.exe`, PowerShell | on the `PATH` | `/mnt/c/Windows/System32/...`, through interop |
| Windows folders (`%USERPROFILE%`, `%TEMP%`) | `os.homedir()`, `os.tmpdir()` | `cmd.exe /c echo %VAR%` + `wslpath -u` |
| Paths returned by file dialogs | Windows paths | Linux paths, converted with `wslpath -w` before `wsl.exe` sees them |

A window connected to WSL hands out `vscode-remote://wsl+<distro>/...` URIs even
when the extension runs on Windows; `toWindowsPath()` converts those too.

## Reading `wsl.exe` output

**Encoding.** `wsl.exe` writes UTF-16LE without a byte order mark, and
`WSL_UTF8=1` is ignored by several builds. Read as UTF-8, every character is
followed by a NUL. `decode()` checks for a BOM and then for the interleaved NUL
pattern.

**Localized columns.** `wsl --list --verbose` translates the STATE column to
the Windows display language, and translations may contain spaces
("Em execução"), so slicing by column breaks. Names come from `--list --quiet`
and running state from `--list --running --quiet`; the verbose output is used
only for the `*` default marker and the last token, the version number.

**Online catalog.** In `wsl --list --online`, the introduction is localized but
the table header stays `NAME  FRIENDLY NAME`, which anchors the parser.

**Registry.** `wsl.exe` does not expose a distro's install folder or default
user. They come from `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss`,
read with `reg.exe`.

**PowerShell.** Windows PowerShell writes in the legacy code page, which
garbled `OneDrive\Área de Trabalho`. Queries that return paths set
`[Console]::OutputEncoding` to UTF-8 first.

## Distro lifecycle

**Started distros stop on their own.** WSL stops a distro about 15 seconds
after its last `wsl.exe` session ends, even with systemd. *Start* therefore
boots the distro and leaves an idle `/bin/sleep` session in it, which keeps it
running until *Stop*, *Restart*, or a shutdown. That session is launched with
`Start-Process -WindowStyle Hidden`: spawned detached from Node, `wsl.exe` has no
console and opens one, which Windows 11 shows as a terminal window; spawned
attached, it dies with the extension host. Its only argument is a number, so no
quoting can break it.

**The tree redraws on state changes.** For an existing tree item id, VS Code
updates the icon shape but not its color, so a started distro kept a gray icon.
Item ids include the state, and the provider remembers which distros are
expanded so they stay expanded across the change.

**Windows interop disappears.** Linux runs `.exe` files through the `WSLInterop`
entry in `binfmt_misc`, which belongs to the kernel every distro shares. When a
distro stops, the entry is removed for all of them. WSL already disables
`systemd-binfmt --unregister`, and the entry still goes, so nothing inside a
distro prevents it. The extension re-registers it in the running distros right
after its own *Stop* and *Unregister*, whenever a refresh shows that a distro
stopped, and on demand. When the extension itself runs inside WSL and a `.exe`
fails, it checks for the missing entry and says so, instead of surfacing the
shell's "cannot execute binary file".

## Disks

**A disk is released only when the VM stops.** Current WSL keeps every
distro's VHDX attached to the VM while any distro runs, including disks of
distros that have stopped and of distros just imported. Compaction and *Move*
fail with a sharing violation until then. `releaseDisk()` stops the distro,
waits for Windows to be able to open the file exclusively, and otherwise asks
to shut WSL down, restarting the distros that were running afterwards (except
Docker, Podman, and Rancher ones, which their tools must start).

**Shutdowns never disconnect VS Code windows.** A shutdown kills every VS Code
window connected to WSL, and those windows retried while WSL was down and then
gave up. Before any of this starts, the extension looks for `wsl.exe`
processes running the VS Code server; if there are any, it refuses and changes
nothing.

**Compaction** runs `diskpart` (`attach vdisk readonly`, `compact vdisk`)
elevated through `Start-Process -Verb RunAs`. An elevated process cannot pipe
its output back, so `cmd.exe` redirects it to a log file that is read
afterwards.

**Reclaimable space** is the VHDX size minus the space used inside the distro
(`df`). The VHDX always holds some file system overhead, so the estimate is
shown only above 2 GB and 10% of the used space. In testing, a 1.2 GB gap gave
back 23 MB and a 9.9 GB gap gave back 8.7 GB.

## Long operations

Export, import, move, install, and backups report progress from the size of
the file being written. Cancelling kills the whole process tree
(`taskkill /T`): on Windows, `wsl.exe` hands the work to a child process, and
killing only the parent left an export writing and an import running. With the
tree killed, an export stops writing and a cancelled import leaves nothing
registered.

## Live metrics

On WSL 2 all distros share one VM, but each has its own PID namespace. Summing
`/proc/<pid>/stat` inside a distro gives that distro's CPU time and memory;
`/proc/stat` and `/proc/meminfo` give the VM totals. One long-running `sh`
loop per distro prints a sample per interval, so `wsl.exe` is not spawned on
every tick.

That loop is shared by every VS Code window. The first window to expand a
distro takes a lock file in `%TEMP%\wsl-distro-manager` and writes each sample
next to it; the others read that file. When the leader stops, it deletes the
lock and a follower takes over. A follower decides that a leader disappeared by
its own clock, from how long the sample file has not changed, never from file
times: the WSL VM clock drifted about 10 seconds from Windows, which made fresh
locks look abandoned. Before taking over, a follower checks that the distro
still runs, so it never boots a distro that just stopped.

## Files inside distros

**`/etc/wsl.conf` needs root.** The `\\wsl.localhost` share accesses a distro
as its default user, so saving to `/etc` fails. A `FileSystemProvider` on the
`wsl-config:` scheme reads and writes through `wsl -u root`, converting CRLF to
LF on save. The distro name is in the URI path, not the authority, because VS
Code lowercases the authority and names such as `FedoraLinux-43` and
`fedora-linux-43` can coexist.

**Backups and sent files run as the default user.** Archivers run with
`wsl --cd ~ --exec`, so no shell parses paths or patterns. Folder permissions
are checked before copying; a folder that would need `sudo` is refused. File
dialogs cannot browse `\\wsl.localhost` (VS Code blocks UNC hosts), so folders
inside a distro are picked from a list of the home folder or typed.
