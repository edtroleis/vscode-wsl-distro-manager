# Release checklist

Automated checks cover parsing, paths, and the Windows host code paths. What is
left needs a real VS Code window and, for compaction, a UAC prompt.

## 1. Automated

```bash
npm test                 # unit tests
npm run smoke            # real WSL, from this host
npm run smoke:windows    # real WSL, from the Windows host (run inside WSL)
```

All three must pass.

## 2. Install the package on Windows

Build the package into a **Windows** folder. VS Code on Windows refuses to open
files under `\\wsl.localhost\...` ("UNC host 'wsl.localhost' access is not
allowed"), so a `.vsix` left inside the distro cannot be installed from there:

```bash
npx vsce package --out /mnt/c/Users/<you>/Downloads/
```

Then, in a **local** VS Code window (not connected to WSL), run
`Extensions: Install from VSIX...` and pick it from `Downloads`, or from WSL:

```bash
cd "/mnt/c/Program Files/Microsoft VS Code/bin" &&
  cmd.exe /c code.cmd --install-extension 'C:\Users\<you>\Downloads\wsl-distro-manager-0.1.0.vsix' --force
```

Reload the window. This is how Marketplace users run the extension: on the
Windows host.

## 3. Manual checks (local window)

- [ ] The **WSL Distro Manager** icon appears in the activity bar and lists every distro.
- [ ] Expanding a stopped distro shows details without starting it (it stays **Stopped**).
- [ ] *Start* turns the icon green, opens no terminal window, and the distro is still running a minute later; *Stop* turns it gray.
- [ ] A distro started outside VS Code (e.g. Windows Terminal) turns green within the refresh interval.
- [ ] Expanding a running distro shows CPU, memory, and processes updating every ~2 s.
- [ ] Collapsing it, or hiding the view, stops the updates (rows show **paused**).
- [ ] The **VHDX** row of a running distro shows reclaimable space when it is over 1 GB.
- [ ] Podman / Docker distros show the tool name, and their context menu has no *Set as Default*, *Edit /etc/wsl.conf*, *Convert*, or *Compact Disk*.
- [ ] *Stop* on a Podman / Docker distro warns that it is managed by that tool.
- [ ] `wslManager.showManagedDistros: false` hides them; `true` brings them back.
- [ ] *Edit /etc/wsl.conf* opens the file; saving offers to restart the distro.
- [ ] *Edit .wslconfig* opens `%USERPROFILE%\.wslconfig`; saving offers `wsl --shutdown`.
- [ ] *Export* suggests `C:\Users\<you>\<distro>.tar` and produces the file.
- [ ] *Import* of that file under a new name creates a working distro; *Unregister* removes it.
- [ ] *Compact Disk* on a distro you can spare:
  - [ ] Declining the UAC prompt shows an error and leaves the distro as it was.
  - [ ] With another distro running, it explains that WSL must shut down, lists the running distros, and offers **Shut Down and Compact**.
  - [ ] That warning says every window connected to WSL will be disconnected, and the progress shows the elapsed time while diskpart runs.
  - [ ] Run from a window connected to WSL, the result offers **Reload Window**, and it reconnects the window.
  - [ ] Accepting it compacts the disk, reports the before/after size, and restarts the distros that were running (not Podman/Docker ones).

## 4. Manual checks (window connected to WSL)

- [ ] The connected distro is tagged **this window**.
- [ ] *Stop* on it warns that the window will be disconnected, even with `wslManager.confirmDestructiveActions: false`.
- [ ] *Export* from this window writes to the Windows path chosen in the dialog.
- [ ] *Import* refuses an install folder under `/home` and accepts one under `/mnt/c`.

## 5. Screenshots

The README uses these PNGs from `images/` (dark theme). Retake the affected ones
when the UI changes:

| File | What it shows |
|---|---|
| `overview.png` | Several distros, one expanded and running: live CPU/memory, details, reclaimable VHDX space, Podman labels. |
| `context-menu.png` | The right-click menu of a distro. |
| `compact.png` | The VHDX row with reclaimable space and the *Compact Disk* confirmation. |
| `compact-shutdown.png` | The confirmation to shut WSL down for the compaction. |
| `compact-progress.png` | The progress notification with the elapsed time. |

They are not packaged in the `.vsix`: `vsce` rewrites the README's relative image
links to the GitHub repository, so they must be committed and pushed before
publishing.
