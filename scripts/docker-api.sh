#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
HOST_USER_DIR="$HOME"
for env_file in "$ROOT_DIR/.env.local" "$ROOT_DIR/services/api/.env.local"; do
    if [ -f "$env_file" ]; then
        set -a
        . "$env_file"
        set +a
    fi
done

export ZENBAR_API_TOKEN="${ZENBAR_API_TOKEN:-}"
export ZENBAR_ALLOW_UNAUTHENTICATED_REMOTE="${ZENBAR_ALLOW_UNAUTHENTICATED_REMOTE:-false}"
export ZENBAR_RUNTIME_MODE="${ZENBAR_RUNTIME_MODE:-app_server_ws}"
export ZENBAR_CORS_ORIGINS="${ZENBAR_CORS_ORIGINS:-http://localhost:8080}"
export ZENBAR_WORKSPACE_ROOT="${ZENBAR_WORKSPACE_ROOT:-/tmp/zenbar-task-workspaces}"
export CODEX_HOME="${CODEX_HOME:-$HOST_USER_DIR/.codex}"
API_PORT="${ZENBAR_DOCKER_API_PORT:-18001}"
PROJECTS_ROOT="${ZENBAR_DOCKER_PROJECTS_ROOT:-$HOST_USER_DIR/Workspace}"
DATABASE_VOLUME="${ZENBAR_DOCKER_DATABASE_VOLUME:-zenbar-data}"
RUNTIME_URL="${ZENBAR_DOCKER_RUNTIME_URL:-ws://host.docker.internal:18765}"

if [ ! -d "$PROJECTS_ROOT" ] || [ ! -d "$ZENBAR_WORKSPACE_ROOT" ]; then
    echo 'Projects root and task workspace directory must exist.' >&2
    exit 1
fi
WORKSPACE_MOUNT_SOURCE="$(CDPATH= cd -- "$ZENBAR_WORKSPACE_ROOT" && pwd -P)"

if ! docker volume inspect "$DATABASE_VOLUME" >/dev/null 2>&1; then
    echo 'Initialize the SQLite volume with pnpm docker:database first.' >&2
    exit 1
fi
docker run --rm --mount "type=volume,src=$DATABASE_VOLUME,dst=/data,readonly" \
    python:3.12-slim python -c 'from pathlib import Path; assert Path("/data/zenbar.db").is_file(), "Database volume is empty"'
if [ -z "$ZENBAR_API_TOKEN" ] && [ "$ZENBAR_ALLOW_UNAUTHENTICATED_REMOTE" != true ]; then
    echo 'Configure ZENBAR_API_TOKEN for dashboard-to-API access.' >&2
    exit 1
fi

# Two control-plane processes must not own the same tasks. Stop the host API
# only after active work is finished, and manage its Codex runtime separately.
HOST_API_PORT="${ZENBAR_API_PORT:-18000}"
if command -v lsof >/dev/null 2>&1 && lsof -tiTCP:"$HOST_API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Host API is still listening on $HOST_API_PORT. Finish active tasks and stop it before migrating." >&2
    exit 1
fi

docker build -t zenbar-api:local "$ROOT_DIR/services/api"
if ! docker network inspect zenbar >/dev/null 2>&1; then
    docker network create zenbar
fi
if docker container inspect zenbar-api >/dev/null 2>&1; then
    docker rm -f zenbar-api
fi

# Keep absolute paths identical to the host runtime and worktree .git files.
# Persist the database and its SQLite journals together in a named volume.
set -- --mount "type=volume,src=$DATABASE_VOLUME,dst=/data" \
    --mount "type=bind,src=$PROJECTS_ROOT,dst=$PROJECTS_ROOT" \
    --mount "type=bind,src=$WORKSPACE_MOUNT_SOURCE,dst=$ZENBAR_WORKSPACE_ROOT"
if [ "$ZENBAR_WORKSPACE_ROOT" = /tmp/zenbar-task-workspaces ]; then
    set -- "$@" --mount "type=bind,src=$WORKSPACE_MOUNT_SOURCE,dst=/private/tmp/zenbar-task-workspaces"
fi
if [ -f "$CODEX_HOME/config.toml" ]; then
    set -- "$@" --mount "type=bind,src=$CODEX_HOME/config.toml,dst=$CODEX_HOME/config.toml"
fi
for profile_file in "$CODEX_HOME"/*.config.toml; do
    if [ -f "$profile_file" ]; then
        set -- "$@" --mount "type=bind,src=$profile_file,dst=$profile_file,readonly"
    fi
done

docker run -d --name zenbar-api --restart unless-stopped --network zenbar \
    --user "$(id -u):$(id -g)" \
    --add-host host.docker.internal:host-gateway \
    -p "127.0.0.1:$API_PORT:8000" "$@" \
    --env ZENBAR_API_TOKEN --env ZENBAR_ALLOW_UNAUTHENTICATED_REMOTE \
    --env ZENBAR_RUNTIME_MODE --env ZENBAR_CORS_ORIGINS \
    --env ZENBAR_WORKSPACE_ROOT --env CODEX_HOME \
    --env ZENBAR_APP_SERVER_MANAGED=false \
    --env "ZENBAR_APP_SERVER_WS_URL=$RUNTIME_URL" \
    --env ZENBAR_DATABASE_URL=sqlite:////data/zenbar.db \
    zenbar-api:local
printf 'API: http://localhost:%s\n' "$API_PORT"
