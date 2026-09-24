# Contributing

Thanks for helping improve Distro Manager for WSL. This guide covers the
development setup, tests, localization, and releases. For how the extension
works, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first.

## Setup

Requirements: Windows with WSL, VS Code, Node.js 22 or later, and Git.

```bash
git clone https://github.com/edtroleis/vscode-wsl-distro-manager.git
cd vscode-wsl-distro-manager
npm install
```

You can work from Windows or from a VS Code window connected to a WSL distro;
the extension supports both hosts.

## Run the extension

1. Open the folder in VS Code.
2. Press **F5**. A second window, the Extension Development Host, opens with
   the extension loaded.
3. After changing code, `npm run watch` recompiles; reload the development
   window with `Ctrl+R`.

If the view does not appear, run **Developer: Show Running Extensions** in the
development window, and **Help > Toggle Developer Tools** for activation
errors.

## Tests

| Command | What it runs |
|---|---|
| `npm test` | Unit tests, with the Node.js test runner and a small mock of the `vscode` module. No VS Code or WSL needed. |
| `npm run smoke` | A read-only check of the real functions against your WSL installation, on the current host. |
| `npm run smoke:windows` | From a WSL shell: the unit tests and the smoke test on the Windows host, using the Node.js runtime bundled with VS Code. |

The unit tests use real `wsl.exe`, `reg.exe`, and `/proc` output as fixtures,
including UTF-16 output and a localized STATE column. When you fix a parsing
bug, add the output that caused it as a fixture.

The user interface is checked by hand before each release with
[docs/TESTING.md](docs/TESTING.md).

## Conventions

- **TypeScript strict mode**; the build must pass `npm run compile` with no
  errors.
- **Keep parsing pure.** Put the logic that interprets command output in a
  function that takes a string, next to the function that runs the command, and
  test it.
- **Comments explain why.** Most workarounds exist because of a WSL behavior;
  say which one, as in the existing code.
- **Every user-visible string goes through `vscode.l10n.t()`**, with `{0}`
  placeholders instead of string concatenation. Write whole sentences: a
  sentence assembled from fragments cannot be translated.
- **Programs by absolute path** (`wsl.system32()`), never by bare name.
- **Never `wsl -u root`.** WSL grants root without a password, bypassing the
  distro's `sudo` rules. Anything privileged inside a distro goes through its
  `sudo`, after the user agrees, with any password on standard input. Nothing
  elevated reads a file that another program could change first. Nothing shuts
  WSL down while VS Code windows are connected to it.

## Localization

The extension ships in English and Brazilian Portuguese.

| File | Contains |
|---|---|
| `l10n/bundle.l10n.json` | English strings from the code, generated. Do not edit. |
| `l10n/bundle.l10n.pt-br.json` | Portuguese translations of those strings. |
| `package.nls.json`, `package.nls.pt-br.json` | Command titles, settings, and other `package.json` strings. |

After adding or changing strings:

```bash
npm run l10n
```

Then add the new keys to `l10n/bundle.l10n.pt-br.json`. `npm test` fails if a
translation is missing or has different placeholders, and CI fails if
`bundle.l10n.json` is out of date.

## Pull requests

1. Create a branch from `main`. Every push to it runs CI: the tests on Ubuntu
   and Windows, the localization check, and packaging.
2. Make the change, with tests when it touches parsing or logic.
3. Run `npm test`, and `npm run smoke` if the change calls `wsl.exe`.
4. **Raise the version** and describe the change in `CHANGELOG.md`: every merge
   to `main` is published, so a pull request whose version is already on the
   Marketplace fails CI.

   ```bash
   npm version patch --no-git-tag-version   # or minor / major
   ```

5. Update the README when behavior visible to users changes.
6. Open the pull request with a description of the problem and how you tested
   the fix. Merge it when CI passes.

## Icons

- `resources/icon.svg` is the source of the Marketplace icon, `resources/icon.png`
  (256 × 256, transparent corners). After editing the SVG, render the PNG with a
  headless browser, for example Edge:
  `msedge --headless=new --default-background-color=00000000 --window-size=256,256 --screenshot=icon.png icon.html`,
  where `icon.html` shows the SVG at 256 px on a transparent page.
- `resources/wsl.svg` is the activity bar icon: a single-color outline of the
  same drawing. VS Code only uses its shape and paints it in the theme color.

## Releases

Releases are automatic. On every push to `main`, the **Release** workflow runs
CI and then, if the version in `package.json` is not on the Marketplace yet,
publishes it, tags it `v<version>`, and creates a GitHub release with the
`.vsix` and that version's `CHANGELOG.md` section. A version that is already
published is skipped.

Before a release that changes the interface, go through
[docs/TESTING.md](docs/TESTING.md) with a package built from the branch (CI
uploads it as the `vsix` artifact of each run), and retake the screenshots in
`images/`. The Marketplace loads them from GitHub.

### Setup (once)

1. Create a publisher `edtroleis` at
   <https://marketplace.visualstudio.com/manage>.
2. Create an Azure DevOps Personal Access Token with **Organization: All
   accessible organizations** and the scope **Marketplace > Manage**.
3. Store it as the `VSCE_PAT` secret of the repository:

   ```bash
   gh secret set VSCE_PAT --repo edtroleis/vscode-wsl-distro-manager
   ```

4. Protect `main` so changes arrive through pull requests with CI passing
   (Settings > Branches, or `gh api`), requiring the checks *Test
   (ubuntu-latest)*, *Test (windows-latest)*, and *Version not yet published*.

The token expires; when publishing fails with an authentication error, create a
new one and run step 3 again.
