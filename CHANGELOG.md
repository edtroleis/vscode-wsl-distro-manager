# Changelog

All notable changes to Distro Manager for WSL are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.0.6] - 2026-09-24

### Changed

- Releases are published from GitHub Actions, signing in with Microsoft
  Entra ID or an organization-scoped token. No change in the extension itself.

## [0.0.5] - 2026-09-24

### Changed

- New icon and a mascot: a penguin in a suit with a clipboard, who keeps your
  distros in order. The activity bar shows it as an outline.
- The *.wslconfig* row no longer shows anything from inside the file, not
  even in its tooltip; click it to open the file. The extension no longer
  reads the file's contents at all.

## [0.0.4] - 2026-09-24

### Changed

- The *Settings (.wslconfig)* row is now *.wslconfig*, and its values (such as
  `memory` and `processors`) moved to its tooltip. The row shows only
  *restart WSL to apply* or *not created* when that applies.

### Fixed

- *Back Up Folders*: typed paths starting with `~` (such as `~/.ssh`) failed,
  because no shell expands `~`. They are now read as relative to your home.
- Live metrics: two VS Code windows taking over from a closed one could both
  start sampling the same distro.
- After a distro stops, Windows interop is checked once, not once for the
  command and again for the next refresh.

## [0.0.3] - 2026-09-24

### Added

- *About*, in the view's `...` menu: the version, with links to the extension
  page, the changelog, and a new issue.
- The log in the Output panel starts with the extension's version, and
  records failed commands.

### Fixed

- *Restart* checks Windows interop in the other running distros afterwards, as
  *Stop* does.
- A failed export removes its incomplete file.

### Security

- `wslExePath`, `defaultUser`, `backupFolder`, and `confirmDestructiveActions`
  are read only from user settings. Before, a project's `.vscode/settings.json`
  could set them, for example to make the extension run a program from the
  project.

### Changed

- The gear in the view's title bar opens the extension's settings. The global
  `.wslconfig` opens from its row under the **WSL** node, or with
  *Edit .wslconfig (Global)* in the Command Palette.

## [0.0.2] - 2026-09-24

### Fixed

- *Back Up Folders*: clicking a folder or a file did not keep it checked. A
  checked folder is backed up whole, without opening it.
- *Back Up Folders*: ➔ on a folder closed the list. Each folder now opens in
  a list of its own.
- *Back Up Folders*: accepting the list with nothing checked closed it and did
  nothing. It now stays open; on a folder, it opens the folder.
- Running distros show a green icon again.
- A second installed copy of the extension (for example under its former ID)
  no longer stops this one from activating; a message says to uninstall one.

### Added

- *Back Up Folders*: a *Back to ...* row at the top of each folder, next to the
  ← button in the title.
- A log in the Output panel (*Distro Manager for WSL*), for reporting problems.

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

[Unreleased]: https://github.com/edtroleis/vscode-wsl-distro-manager/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/edtroleis/vscode-wsl-distro-manager/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/edtroleis/vscode-wsl-distro-manager/releases/tag/v0.0.1
