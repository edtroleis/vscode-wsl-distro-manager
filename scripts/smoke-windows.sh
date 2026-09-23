#!/usr/bin/env bash
# Runs the smoke test and the unit tests on the Windows host, from inside WSL,
# using the Node.js runtime bundled with VS Code (ELECTRON_RUN_AS_NODE). This
# exercises the Windows code paths (wsl.exe on PATH, reg.exe, os.homedir)
# without installing Node on Windows.
set -euo pipefail
cd "$(dirname "$0")/.."

code_exe="${VSCODE_EXE:-/mnt/c/Program Files/Microsoft VS Code/Code.exe}"
if [[ ! -x "$code_exe" ]]; then
  echo "VS Code not found at $code_exe; set VSCODE_EXE to its Code.exe." >&2
  exit 1
fi

temp_win="$(/mnt/c/Windows/System32/cmd.exe /c 'echo %TEMP%' 2>/dev/null | tr -d '\r')"
work="$(wslpath -u "$temp_win")/wsl-distro-manager-test"
rm -rf "$work"
mkdir -p "$work"
cp -r out package.json "$work/"
trap 'rm -rf "$work"' EXIT

# Run from the copy so that relative paths resolve on the Windows side.
run_node() {
  (cd "$work" && ELECTRON_RUN_AS_NODE=1 WSLENV=ELECTRON_RUN_AS_NODE "$code_exe" --require ./out/test/setup.js "$@")
}

echo "== unit tests (Windows) =="
run_node --test "out/test/**/*.test.js"
echo
echo "== smoke test (Windows) =="
run_node out/test/smoke.js
