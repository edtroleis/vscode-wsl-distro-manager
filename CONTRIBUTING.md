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
6. Open the pull request; its template lists what to describe and check.
   Merge it when CI passes.

Report bugs and ideas with the [issue forms](https://github.com/edtroleis/vscode-wsl-distro-manager/issues/new/choose),
and vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Icons

- `resources/mascot.svg` is the mascot: a penguin in a suit with a clipboard,
  who keeps the distros in order. `resources/icon.svg` places the same drawing on
  the brand blue; keep the two in sync.
- `resources/icon.svg` is the source of the Marketplace icon, `resources/icon.png`
  (256 × 256, transparent corners), and `resources/mascot.svg` of
  `images/mascot.png` (400 × 400, transparent), shown at the top of the README.
  After editing an SVG, render the PNG with a headless browser, for example Edge:
  `msedge --headless=new --default-background-color=00000000 --window-size=256,256 --screenshot=icon.png icon.html`,
  where `icon.html` shows the SVG at 256 px on a transparent page.
- `resources/wsl.svg` is the activity bar icon: a single-color outline of the
  mascot with its clipboard, simple enough to read at 24 px. VS Code only uses
  its shape and paints it in the theme color.

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

The **Release** workflow publishes from the `marketplace` environment, which
only `main` may use (Settings > Environments). Give it credentials in one of
two ways.

#### Option A: Microsoft Entra ID (recommended)

GitHub Actions signs in to Azure with OIDC and gets a short-lived token; no
secret is stored. It needs an Azure subscription (a free one works; a managed
identity costs nothing).

Run the `az` commands in [Azure Cloud Shell](https://portal.azure.com/#cloudshell/)
(Bash; already signed in), or install the Azure CLI (on Fedora,
`sudo dnf install azure-cli`) and run `az login` first (inside WSL,
`az login --use-device-code`, since the CLI cannot open the Windows browser).
Check the subscription with `az account show`.

1. Create a user-assigned managed identity:

   ```bash
   az group create --name vscode-publish --location eastus
   az identity create --name vscode-wsl-distro-manager-publisher --resource-group vscode-publish
   ```

   Note its `clientId`, `tenantId`, and `id` (the resource ID).
2. Let this repository's `marketplace` environment sign in as it:

   ```bash
   az identity federated-credential create \
     --name github-marketplace \
     --identity-name vscode-wsl-distro-manager-publisher \
     --resource-group vscode-publish \
     --issuer https://token.actions.githubusercontent.com \
     --subject repo:edtroleis/vscode-wsl-distro-manager:environment:marketplace \
     --audiences api://AzureADTokenExchange
   ```

3. At <https://marketplace.visualstudio.com/manage/publishers/edtroleis>,
   open **Members** and add the identity by its resource ID, with the
   **Contributor** role.
4. Store the IDs as variables of the environment (they are not secrets):

   ```bash
   gh variable set AZURE_CLIENT_ID --env marketplace --body <clientId>
   gh variable set AZURE_TENANT_ID --env marketplace --body <tenantId>
   gh variable set AZURE_SUBSCRIPTION_ID --env marketplace --body <subscriptionId>
   ```

#### Option B: Azure DevOps token

1. In an Azure DevOps organization (create a free one if needed), create a
   Personal Access Token for **that organization** with the scope
   **Marketplace > Manage**. Global tokens (*All accessible organizations*)
   stop working on 2026-12-01.
2. Store it as a secret of the environment; the command asks for the value:

   ```bash
   gh secret set VSCE_PAT --env marketplace --repo edtroleis/vscode-wsl-distro-manager
   ```

The token expires. When publishing fails with an authentication error,
create a new one and run step 2 again. With both options set, the workflow
uses Entra ID.

#### Protect main

Require pull requests with CI passing before merging to `main` (Settings >
Branches), with the checks *Test (ubuntu-latest)*, *Test (windows-latest)*,
and *Version not yet published*.
