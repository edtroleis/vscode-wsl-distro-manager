# Changelog

## 0.1.0

Initial release.

- Sidebar view listing WSL distros with state, version, and default marker; the distro of the current window is tagged "this window".
- Expandable distro details: OS, kernel, default user, disk usage, install location, VHDX size, and how much space a compaction would reclaim.
- Live CPU, memory, and process count for expanded running distros.
- Compact a distro's VHDX with diskpart to give disk space back to Windows. When WSL keeps the disk attached (any distro running), it offers to shut WSL down and restarts the distros afterwards.
- Start, stop, restart, set default, convert WSL 1/2, export, import, unregister, shut down WSL.
- Open a terminal (default user or root) or a new VS Code window connected to a distro.
- Edit `/etc/wsl.conf` (as root) and the global `.wslconfig`, with a prompt to apply changes on save.
- Distros created by Docker Desktop, Podman, and Rancher Desktop are labeled, hidden from configuration actions, and protected by warnings; they can also be hidden from the list.
- Actions that would disconnect the current window always ask first, even with confirmations turned off.
- A clear error, with the fix, when Windows interop was unregistered by another distro stopping.
- Export and import work from windows connected to WSL, where file dialogs return Linux paths.
