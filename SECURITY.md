# Security policy

## Supported versions

Only the latest version on the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=edtroleis.vscode-wsl-distro-manager)
receives fixes. Update the extension before reporting.

## Reporting a vulnerability

Report vulnerabilities privately through a
[GitHub security advisory](https://github.com/edtroleis/vscode-wsl-distro-manager/security/advisories/new).
Do not open a public issue.

Include:

- the extension version (run **About** from the view's `...` menu), and the
  WSL and Windows versions;
- what an attacker can do, and what they need first (for example, another
  program running as the same Windows user);
- the steps to reproduce it.

You will get an answer within 7 days. A confirmed issue is fixed in a new
release, and the advisory is published after that release, crediting you
unless you prefer otherwise.

## Scope

In scope: anything that lets the extension run code, gain privileges, or
expose data beyond what the user asked for. For example: running as root in a
distro without consent, elevating through UAC with commands the user did not
see, command injection through distro names or paths, or backups written
somewhere the user did not choose.

Out of scope: what WSL itself allows the Windows user to do (such as
`wsl -u root`), and vulnerabilities in WSL, Windows, or VS Code, which go to
Microsoft.

The design is described in the README's
[Security](README.md#security) section and in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#privileges).
