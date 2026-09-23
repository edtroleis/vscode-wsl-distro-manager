# Changelog

## 0.1.0

Initial release.

- Sidebar view listing WSL distros with state, version, and default marker.
- Expandable distro details: OS, kernel, default user, disk usage, install location, VHDX size.
- Live CPU, memory, and process count for expanded running distros.
- Start, stop, restart, set default, convert WSL 1/2, export, import, unregister, shut down WSL.
- Open a terminal (default user or root) or a new VS Code window connected to a distro.
- Edit `/etc/wsl.conf` (as root) and the global `.wslconfig`, with a prompt to apply changes on save.
