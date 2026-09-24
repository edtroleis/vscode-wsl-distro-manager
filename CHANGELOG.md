# Changelog

All notable changes to WSL Distro Manager are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.0.1] - 2026-09-24

First release.

### Added

- **Distro view** in the activity bar, listing every WSL distro with its state,
  WSL version, and default marker. The distro of the current window is tagged
  *this window*.
- **WSL node** at the top of the view for what applies to all distros: the
  global `.wslconfig`, with its main settings summarized, and the WSL and
  kernel versions.
- **Details** on expand: OS, kernel, default user, disk usage, install location,
  virtual disk size, and the space a compaction would reclaim.
- **Live CPU, memory, and process count** for running distros, next to the WSL
  VM totals, sampled once per distro and shared by every VS Code window.
- **Lifecycle**: start, stop, restart, set the default distro, unregister, shut
  down WSL, and **Restart WSL**, which starts again only the distros that were
  running. Started distros keep running until stopped.
- **Terminals and windows**: open a terminal in a distro, or a new VS Code
  window connected to it.
- **Install** distros from the online catalog, with a chosen name and location.
- **Export and import** (`.tar` or `.vhdx`) with progress and cancel.
- **Move** a distro's virtual disk to another folder or drive.
- **Compact** a distro's virtual disk to give unused space back to Windows,
  with an estimate of the gain.
- **Back up** chosen folders, whole or just items inside them, to a `.tar.gz`
  or `.zip` on the Windows Desktop or another folder, and **send files** from Windows into a distro, extracting
  backups in place.
- **`.wslconfig` editing**, with a prompt to restart WSL on save and a pending
  mark until the change applies.
- **Repair Windows Interop**, which WSL removes from running distros when one
  stops.
- **Languages**: English and Brazilian Portuguese.

### Security

- Nothing runs as root inside a distro without the user's consent: the only
  privileged step, repairing Windows interop, runs through the distro's `sudo`
  after the user agrees. `wsl -u root`, which needs no password, is never used,
  and no distro system file is edited.
- Administrator rights only through the Windows UAC prompt (compaction), with
  the `diskpart` commands passed inside the elevated process, not through a
  file.
- Windows programs are started by absolute path, never looked up by name.
- Compacting and moving refuse to shut WSL down while VS Code windows are
  connected to it; other shutdowns name the windows that will disconnect.
- Distros managed by Docker Desktop, Podman, and Rancher Desktop are labeled,
  lose configuration actions, and warn before being stopped or unregistered.
- Backups and sent files run as the distro's default user, and backups that
  include folders usually holding credentials ask first.

[Unreleased]: https://github.com/edtroleis/vscode-wsl-distro-manager/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/edtroleis/vscode-wsl-distro-manager/releases/tag/v0.0.1
