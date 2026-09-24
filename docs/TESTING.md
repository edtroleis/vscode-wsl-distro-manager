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
  cmd.exe /c code.cmd --install-extension 'C:\Users\<you>\Downloads\wsl-distro-manager-<version>.vsix' --force
```

Then run **Developer: Reload Window**.

## 3. Local VS Code window

### View and details
- [ ] The **WSL Distro Manager** icon appears in the activity bar, and the view lists every distro.
- [ ] Expanding a stopped distro shows its details without starting it; it stays **Stopped**.
- [ ] Expanding a running distro shows CPU, memory, and processes, updating every 2 seconds.
- [ ] Collapsing it, or hiding the view, stops the updates; the rows show **paused**.
- [ ] With two VS Code windows showing the same expanded distro, both update, and only one sampling `wsl.exe` runs.
- [ ] The **VHDX** row of a running distro shows reclaimable space only when the gap is at least 2 GB and 10% of the used space.

### Lifecycle
- [ ] *Start* turns the icon green, opens no terminal window, and the distro is still running a minute later.
- [ ] *Stop* turns the icon gray.
- [ ] A distro started outside VS Code (for example from Windows Terminal) turns green within the refresh interval.
- [ ] Stopping a distro while another runs: `cmd.exe /c ver` still works in the other one's terminal, or works again after the next refresh. **Repair Windows Interop** reports the result.

### Distros managed by other tools
- [ ] Podman and Docker distros show the tool's name, and their context menu has no *Set as Default*, *Edit /etc/wsl.conf*, *Convert*, *Compact Disk*, *Move*, *Back Up Folders*, or *Send Files*.
- [ ] *Stop* on one of them warns that the tool manages it.
- [ ] `wslManager.showManagedDistros: false` hides them; `true` shows them again.

### Configuration files
- [ ] *Edit /etc/wsl.conf* opens the file; saving offers to restart the distro.
- [ ] *Edit .wslconfig* opens `%USERPROFILE%\.wslconfig`; saving offers to run `wsl --shutdown`.

### Install, export, import, move
- [ ] *Install Distro...* lists the online catalog. Installing one under a custom name works, and *Open Terminal* finishes its setup. Cancelling leaves nothing registered.
- [ ] *Export* suggests `C:\Users\<you>\<distro>.tar`, shows progress, and creates the file. Cancelling removes the partial file.
- [ ] *Import* of that file under a new name creates a working distro, and *Unregister* removes it.
- [ ] *Move to Another Folder...* moves the VHDX (check *Location*), and the distro still starts.

### Backups and sending files
- [ ] *Back Up Folders...* lists the home folder and saves `<distro>-backup-<date>.tar.gz` to the real Desktop (also when it is in OneDrive), without `node_modules`. *Show in Folder* opens it.
- [ ] Choosing `.zip` in a distro without `zip` says so.
- [ ] *Send Files to Distro...* copies to `~`. Sending to `/root` reports that there is no permission and changes nothing.
- [ ] Sending a file that already exists asks, in the prompt, whether to overwrite or skip.
- [ ] Sending a backup asks, in the prompt, *Send and extract* or *Only send*; extracting restores it. No question appears as a notification.
- [ ] Every text prompt shows a **✓ Confirm** row that confirms with a click; Enter confirms too.

### Compact Disk (on a distro you can spare)
- [ ] The first confirmation states the expected gain, or warns that there is little to reclaim.
- [ ] Declining the UAC prompt shows an error and leaves the distro as it was.
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
| `overview.png` | Several distros, one expanded and running: live metrics, details, reclaimable VHDX space, Podman labels. |
| `compact.png` | The VHDX row with reclaimable space and the *Compact Disk* confirmation. |
| `compact-shutdown.png` | The confirmation to shut WSL down for a compaction. |
| `compact-progress.png` | The compaction progress with the elapsed time. |
| `context-menu.png` | The context menu of a running distro. |
