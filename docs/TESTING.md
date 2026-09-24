# Release checklist

Run through this list before every release. The automated checks cover parsing,
path conversion, and the Windows host code paths; the manual checks cover what
needs a real VS Code window and, for compaction, a UAC prompt.

Use distros you can spare for anything that stops, moves, compacts, or
unregisters. Importing a copy of a small distro (for example an export of a
Podman distro) under a test name works well.

## 1. Automated checks

```bash
npm test                 # unit tests
npm run smoke            # real WSL, from the current host
npm run smoke:windows    # real WSL, from the Windows host (run inside WSL)
```

All three must pass.

## 2. Install the package on Windows

Marketplace users run the extension on the Windows host, so test it there.
Build the package into a Windows folder; VS Code on Windows cannot open files
under `\\wsl.localhost`:

```bash
npx vsce package --out /mnt/c/Users/<you>/Downloads/
```

In a local VS Code window (not connected to WSL), run **Extensions: Install from
VSIX...** and pick the file, or install it from WSL:

```bash
cd "/mnt/c/Program Files/Microsoft VS Code/bin" &&
  cmd.exe /c code.cmd --install-extension 'C:\Users\<you>\Downloads\vscode-wsl-distro-manager-<version>.vsix' --force
```

Then run **Developer: Reload Window**.

## 3. Local VS Code window

### View and details
- [ ] The **Distro Manager for WSL** icon appears in the activity bar, and the view lists every distro.
- [ ] Expanding a stopped distro shows its details without starting it; it stays **Stopped**.
- [ ] Expanding a running distro shows CPU, memory, and processes, updating every 2 seconds, with the VM totals in the same rows (for example `2.8 GB · VM 5.3 GB of 24.5 GB`).
- [ ] Collapsing it, or hiding the view, stops the updates; the rows show **paused**.
- [ ] With two VS Code windows showing the same expanded distro, both update, and only one sampling `wsl.exe` runs.
- [ ] The **VHDX** row of a running distro shows reclaimable space only when the gap is at least 2 GB and 10% of the used space.

### Lifecycle
- [ ] *Start* turns the icon green, opens no terminal window, and the distro is still running a minute later.
- [ ] *Stop* turns the icon gray.
- [ ] A distro started outside VS Code (for example from Windows Terminal) turns green within the refresh interval.
- [ ] Stopping a distro while another runs: if `cmd.exe /c ver` stops working in the other one, a notification offers **Repair...** within about 15 seconds. Nothing is repaired without it.
- [ ] **Repair Windows Interop** shows the exact command, runs it through `sudo`, asks for the password only if the distro requires it, rejects a wrong one without changes, and reports success.

### Distros managed by other tools
- [ ] Podman and Docker distros show the tool's name, and their context menu has no *Set as Default*, *Compact Disk*, *Move*, *Back Up Folders*, or *Send Files*.
- [ ] *Stop* on one of them warns that the tool manages it.
- [ ] `wslManager.showManagedDistros: false` hides them; `true` shows them again. With only managed distros installed and the setting off, the view says they are hidden.

### Configuration files
- [ ] The **WSL** node is first in the view and expanded; it shows *Settings (.wslconfig)* with a summary of the file (or *WSL defaults*) and *Version* with the WSL and kernel versions. Distros list no configuration files, and no menu offers to edit `/etc/wsl.conf`.
- [ ] Clicking *Settings (.wslconfig)* opens `%USERPROFILE%\.wslconfig`; saving updates the summary and says the change applies after WSL (not Windows) restarts, with **Restart WSL Now**.
- [ ] After saving without restarting, the row shows *restart WSL to apply* with a warning icon and an inline restart button, also after reloading the window.
- [ ] **Restart WSL** from a window connected to WSL (with the extension running there) refuses and explains why.
- [ ] **Restart WSL** lists the running distros, stops WSL, and starts again only those that were running (not Podman/Docker ones); stopped distros stay stopped, and the pending mark disappears.
- [ ] Collapsing the **WSL** node keeps it collapsed across refreshes.

### Install, export, import, move
- [ ] *Install Distro...* lists the online catalog. Installing one under a custom name works, and *Open Terminal* finishes its setup. Cancelling leaves nothing registered.
- [ ] *Export* suggests `C:\Users\<you>\<distro>.tar`, shows progress, and creates the file. Cancelling removes the partial file.
- [ ] *Import* of that file under a new name creates a working distro, and *Unregister* removes it.
- [ ] *Move to Another Folder...* moves the VHDX (check *Location*), and the distro still starts.

### Backups and sending files
- [ ] In *Back Up Folders...*, checking a folder takes all of it; its ➔ opens it to choose items inside; *Everything in ...* takes the folder again and unchecks the items; ↑ goes up; choices survive navigation, and the archive holds exactly what was checked.
- [ ] Checking *Everything in your home folder* with `.ssh` or `.aws` in it triggers the credentials warning.
- [ ] *Back Up Folders...* lists the home folder and saves `<distro>-backup-<date>.tar.gz` to the real Desktop (also when it is in OneDrive), without `node_modules`. *Show in Folder* opens it.
- [ ] Choosing `.zip` in a distro without `zip` says so.
- [ ] Including `.ssh` (or `.aws`, `.kube`) asks first, says the archive is not encrypted, and mentions the cloud when the destination is in OneDrive.
- [ ] *Send Files to Distro...* copies to `~`. Sending to `/root` reports that there is no permission and changes nothing.
- [ ] Sending a file that already exists asks, in the prompt, whether to overwrite or skip.
- [ ] Sending a backup asks, in the prompt, *Send and extract* or *Only send*; extracting restores it. No question appears as a notification.
- [ ] Every text prompt shows a **✓ Confirm** row that confirms with a click; Enter confirms too.

### Compact Disk (on a distro you can spare)
- [ ] The first confirmation states the expected gain, or warns that there is little to reclaim.
- [ ] Declining the UAC prompt shows an error and leaves the distro as it was, and no `wsl-distro-manager-*.log` is left in `%TEMP%`.
- [ ] With a VS Code window connected to WSL, it refuses before stopping anything, names that window's distro, and the connected window keeps working.
- [ ] With no window connected and another distro running, it asks to shut WSL down, lists the running distros, and offers **Shut Down and Compact**. The progress shows the elapsed time.
- [ ] Accepting compacts the disk, reports the size before and after, and restarts the distros that were running, except Podman and Docker ones.

### Languages
- [ ] With VS Code in Portuguese (**Configure Display Language** → `pt-br`, with the Portuguese (Brazil) Language Pack), the view, menus, prompts, and settings are in Portuguese.

## 4. VS Code window connected to WSL

- [ ] The connected distro is tagged **this window**.
- [ ] *Stop* on it warns that the window will be disconnected, even with `wslManager.confirmDestructiveActions` set to `false`.
- [ ] *Export* from this window writes to the Windows path chosen in the dialog.
- [ ] *Import* refuses an install folder under `/home` and accepts one under `/mnt/c`.
- [ ] *Move* and *Compact Disk* refuse without changing anything.

## 5. Screenshots

The README shows these images from `images/`, taken with a dark theme. Retake
the ones affected by interface changes. They are not packaged in the `.vsix`:
the Marketplace loads them from GitHub, so commit and push them before
publishing.

| File | Shows |
|---|---|
| `demo.gif` *(retake: shows .wslconfig under the distro and Edit /etc/wsl.conf)* | The top of the README: expanding a running distro (live metrics, reclaimable space), the context menu, and a backup. Under 5 MB, recorded with ScreenToGif at 12 fps. |
| `overview.png` | The WSL node and several distros, one expanded and running: live metrics with VM totals, details, reclaimable VHDX space, Podman labels. |
| `compact.png` *(retake: shows `.wslconfig` under the distro)* | The VHDX row with reclaimable space and the *Compact Disk* confirmation. |
| `compact-shutdown.png` | The confirmation to shut WSL down for a compaction. |
| `compact-progress.png` | The compaction progress with the elapsed time. |
| `context-menu.png` *(retake: shows Edit /etc/wsl.conf and Convert, which were removed)* | The context menu of a running distro. |
