# Contributing

Thanks for helping improve WSL Distro Manager. This guide covers the
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
- **Nothing runs as root** except editing `/etc/wsl.conf`, and nothing shuts
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

1. Create a branch from `main`.
2. Make the change, with tests when it touches parsing or logic.
3. Run `npm test`, and `npm run smoke` if the change calls `wsl.exe`.
4. Update `CHANGELOG.md` under **Unreleased**, and the README when behavior
   visible to users changes.
5. Open the pull request with a description of the problem and how you tested
   the fix.

## Releases

1. Move the **Unreleased** entries in `CHANGELOG.md` under the new version,
   and update `version` in `package.json`.
2. Build the package into a Windows folder. VS Code on Windows cannot install
   a `.vsix` stored inside a distro.

   ```bash
   npx vsce package --out /mnt/c/Users/<you>/Downloads/
   ```

3. Install it in a local VS Code window (**Extensions: Install from VSIX...**)
   and go through [docs/TESTING.md](docs/TESTING.md).
4. Retake screenshots in `images/` if the interface changed. They are not
   packaged: the Marketplace loads them from GitHub, so push them first.
5. Commit, tag (`git tag v<version>`), and push with tags.
6. Publish with `npx vsce publish` (publisher `edtroleis`; `npx vsce login
   edtroleis` needs a Personal Access Token with the **Marketplace > Manage**
   scope).
