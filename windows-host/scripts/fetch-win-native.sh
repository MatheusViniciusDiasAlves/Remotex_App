#!/usr/bin/env bash
# Baixa o binário nativo do koffi para Windows x64 (necessário ao gerar o instalador a partir
# de Linux/macOS: o npm só instala o binário da plataforma atual).
set -euo pipefail
cd "$(dirname "$0")/.."
VER="$(node -p "require('./node_modules/koffi/package.json').version")"
DEST="node_modules/@koromix/koffi-win32-x64"
if [ -f "$DEST/package.json" ] && [ "$(node -p "require('./$DEST/package.json').version")" = "$VER" ]; then exit 0; fi
TMP="$(mktemp -d)"
(cd "$TMP" && npm pack "@koromix/koffi-win32-x64@$VER" --silent >/dev/null)
mkdir -p "$DEST"
tar -xzf "$TMP"/koromix-koffi-win32-x64-*.tgz -C "$DEST" --strip-components=1
rm -rf "$TMP"
echo "✓ koffi win32-x64 $VER"
