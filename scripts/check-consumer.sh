#!/usr/bin/env bash
# Packs the built packages, installs the tarballs into a clean project, then typechecks
# and imports every entry point. Run `vp run build` first.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$root"
vp pm pack -r --filter './packages/*' --pack-destination "$work/tarballs" > /dev/null

# The optional driver peers, at the versions the SQLite package requires.
drivers="$(node -p "const p = require('$root/packages/effect-slotdb-sqlite/package.json').peerDependencies; ['@effect/sql-sqlite-node', '@effect/sql-sqlite-bun'].map(n => n + '@' + p[n]).join(' ')")"

cp "$root"/scripts/consumer/* "$work"
cd "$work"
npm install --no-audit --no-fund --loglevel=error \
  ./tarballs/*.tgz $drivers @types/node @types/bun
"$root/node_modules/.bin/tsc" -p .
node index.ts
