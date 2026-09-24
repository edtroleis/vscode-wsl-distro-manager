# Changelog

All notable changes to WSL Distro Manager are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.1] - 2026-09-23

### Changed

- The README shows the release status and the Marketplace version.
- New versions are published automatically from the repository.

## [1.0.0] - 2026-09-23

First release.

### Added

- **Distro view** in the activity bar, listing every WSL distro with its state,
  WSL version, and default marker. The distro of the current window is tagged
  *this window*.
- **Details** on expand: OS, kernel, default user, disk usage, install location,
  virtual disk size, and the space a compaction would reclaim.
- **Live CPU, memory, and process count** for running distros, sampled once per
  distro and shared by every VS Code window.
- **Lifecycle**: start, stop, restart, set the default distro, convert between
  WSL 1 and WSL 2, unregister, and shut down WSL. Started distros keep running
  until stopped.
- **Terminals and windows**: open a terminal in a distro, or a new VS Code
  window connected to it.
- **Install** distros from the online catalog, with a chosen name and location.
- **Export and import** (`.tar` or `.vhdx`) with progress and cancel.
- **Move** a distro's virtual disk to another folder or drive.
- **Compact** a distro's virtual disk to give unused space back to Windows,
  with an estimate of the gain.
- **Back up** chosen folders to a `.tar.gz` or `.zip` on the Windows Desktop or
  another folder, and **send files** from Windows into a distro, extracting
  backups in place.
- **Configuration files**: edit a distro's `/etc/wsl.conf` (saved as root) and
  the global `.wslconfig`, with a prompt to apply changes on save.
- **Repair Windows Interop** command, and automatic repair when a distro stops.
- **Languages**: English and Brazilian Portuguese.

### Safety

- Destructive actions ask for confirmation; unregistering requires typing the
  distro name.
- Compaction and moving refuse to shut WSL down while VS Code windows are
  connected to it, and change nothing.
- Actions that would disconnect the current window always ask, even with
  confirmations turned off.
- Distros managed by Docker Desktop, Podman, and Rancher Desktop are labeled,
  lose configuration actions, and warn before being stopped or unregistered.
- Backups and sent files run as the distro's default user and never use `sudo`.

[Unreleased]: https://github.com/edtroleis/vscode-wsl-distro-manager/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/edtroleis/vscode-wsl-distro-manager/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/edtroleis/vscode-wsl-distro-manager/releases/tag/v1.0.0
