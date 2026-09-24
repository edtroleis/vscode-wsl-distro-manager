#!/usr/bin/env bash
# Prints the extension id and version from package.json, and whether that
# version is already on the VS Code Marketplace. Used by CI (to require a
# version bump in pull requests) and by the release workflow (to publish each
# new version once). Writes `id`, `version`, and `published` to $GITHUB_OUTPUT
# when running in GitHub Actions.
set -euo pipefail
cd "$(dirname "$0")/.."

id="$(node -p "require('./package.json').publisher + '.' + require('./package.json').name")"
version="$(node -p "require('./package.json').version")"

# flags=1 includes every published version of the extension.
versions="$(curl -fsS -X POST 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json;api-version=3.0-preview.1' \
  -d "{\"filters\":[{\"criteria\":[{\"filterType\":7,\"value\":\"$id\"}]}],\"flags\":1}" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s).results[0].extensions[0];console.log((e?e.versions:[]).map(v=>v.version).join("\n"))})')"

if grep -qxF "$version" <<<"$versions"; then published=true; else published=false; fi
echo "$id $version published=$published"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  { echo "id=$id"; echo "version=$version"; echo "published=$published"; } >>"$GITHUB_OUTPUT"
fi
