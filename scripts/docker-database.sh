#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
DATABASE_FILE="${ZENBAR_DOCKER_DATABASE_FILE:-$ROOT_DIR/services/api/zenbar.db}"
DATABASE_VOLUME="${ZENBAR_DOCKER_DATABASE_VOLUME:-zenbar-data}"
# Colima shares the repository's /Users path, but not macOS's TMPDIR.
mkdir -p "$ROOT_DIR/tmp"
SNAPSHOT_DIR="$(mktemp -d "$ROOT_DIR/tmp/db-snapshot.XXXXXX")"
trap 'rm -rf "$SNAPSHOT_DIR"' EXIT HUP INT TERM

# SQLite's online backup API gives a consistent snapshot while the host is
# running. Never copy the live file directly or import app (which starts APIs).
python3 - "$DATABASE_FILE" "$SNAPSHOT_DIR/zenbar.db" <<'PY'
import sqlite3
import sys
from pathlib import Path

source = sqlite3.connect(Path(sys.argv[1]).resolve().as_uri() + '?mode=ro', uri=True)
target = sqlite3.connect(sys.argv[2])
try:
    source.backup(target, pages=256)
    if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise RuntimeError('Snapshot integrity check failed')
finally:
    target.close()
    source.close()
PY

if ! docker volume inspect "$DATABASE_VOLUME" >/dev/null 2>&1; then
    docker volume create "$DATABASE_VOLUME"
fi
docker run --rm -i \
    --mount "type=bind,src=$SNAPSHOT_DIR,dst=/snapshot,readonly" \
    --mount "type=volume,src=$DATABASE_VOLUME,dst=/data" \
    --env "ZENBAR_DATA_UID=$(id -u)" --env "ZENBAR_DATA_GID=$(id -g)" \
    python:3.12-slim python - <<'PY'
import hashlib
import os
import shutil
import sqlite3
from pathlib import Path

destination = Path('/data/zenbar.db')
if destination.exists():
    raise SystemExit('Database volume already contains data; refusing to overwrite it.')
source = Path('/snapshot/zenbar.db')
temporary = Path('/data/zenbar.db.import')
shutil.copyfile(source, temporary)
if hashlib.sha256(source.read_bytes()).digest() != hashlib.sha256(temporary.read_bytes()).digest():
    raise RuntimeError('Database snapshot checksum mismatch')
uid, gid = int(os.environ['ZENBAR_DATA_UID']), int(os.environ['ZENBAR_DATA_GID'])
os.chown('/data', uid, gid)
os.chown(temporary, uid, gid)
temporary.chmod(0o600)
temporary.replace(destination)
connection = sqlite3.connect('file:/data/zenbar.db?mode=ro', uri=True)
try:
    assert connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    for table in ('projects', 'tasks', 'conversations', 'task_events'):
        count = connection.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
        print(f'{table}: {count}')
finally:
    connection.close()
print('Snapshot copied and verified. No API or agent runtime was started.')
PY
printf 'SQLite Docker volume: %s (/data/zenbar.db)\n' "$DATABASE_VOLUME"
