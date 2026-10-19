#!/usr/bin/env bash
# sync-app-hermes.sh — push runtime + bundle 0.5.104 ke hermes.
# server.js diambil dari .next/standalone/server.js (tidak ada di root repo).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${HOST:-hermes}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/payload"
cp -a "$REPO/package.json" "$REPO/custom-server.js" "$REPO/src" "$REPO/open-sse" "$REPO/prompts" "$TMP/payload/"
# The gateway runs `custom-server.js` (app dir) which requires app/server.js.
# That server.js must come from the SAME build we ship, otherwise its baked
# `distDir` points at a directory that was never copied. We ship
# .next-cli-build (built with NEXT_DIST_DIR=.next-cli-build), whose server.js
# expects distDir "./.next-cli-build" — present in the app dir. A stale
# .next/standalone/server.js expects "./.next" and fails with
# "Could not find a production build in the './.next' directory".
if [ -f "$REPO/.next-cli-build/standalone/server.js" ]; then
  cp -a "$REPO/.next-cli-build/standalone/server.js" "$TMP/payload/server.js"
else
  cp -a "$REPO/.next/standalone/server.js" "$TMP/payload/server.js"
fi
cp -a "$REPO/.next-cli-build" "$TMP/payload/.next-cli-build"

BUILD_ID=$(cat "$TMP/payload/.next-cli-build/BUILD_ID" 2>/dev/null || echo unknown)
echo "[sync] BUILD_ID: $BUILD_ID"
echo "[sync] server.js distDir: $(grep -o '\"distDir\":\"[^\"]*\"' "$TMP/payload/server.js" | head -1)"

echo "[sync] payload size: $(du -sh "$TMP/payload" | cut -f1)"
tar -C "$TMP/payload" -cf - . | ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" "
  set -e
  tar -C ~/.local/lib/node_modules/9router/app -xf -
  echo SYNC-OK
  grep '\"version\"' ~/.local/lib/node_modules/9router/app/package.json | head -1
  echo \"remote BUILD_ID: \$(cat ~/.local/lib/node_modules/9router/app/.next-cli-build/BUILD_ID)\"
"
