# Changelog

## Unreleased

- Fix export and import when the extension runs on the WSL side or the window is connected to WSL: dialog paths are now converted to Windows paths before calling `wsl.exe`, and dialogs open in the Windows user profile.
- Import refuses an install folder inside a distro's filesystem, since the new disk must live on a Windows drive.
- Stopping, restarting, converting, or unregistering the distro this window is connected to, or shutting down WSL from such a window, now always asks for confirmation and warns that the window will be disconnected.
- The distro of the current window is marked "this window" in the list.

## 0.1.0

Initial release.

- Sidebar view listing WSL distros with state, version, and default marker.
- Expandable distro details: OS, kernel, default user, disk usage, install location, VHDX size.
- Live CPU, memory, and process count for expanded running distros.
- Start, stop, restart, set default, convert WSL 1/2, export, import, unregister, shut down WSL.
- Open a terminal (default user or root) or a new VS Code window connected to a distro.
- Edit `/etc/wsl.conf` (as root) and the global `.wslconfig`, with a prompt to apply changes on save.
