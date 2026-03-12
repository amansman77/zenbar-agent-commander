#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"

cd "$ROOT_DIR"
exec env COREPACK_HOME=/tmp/corepack pnpm --filter web dev -- --host 127.0.0.1 --port 5173
