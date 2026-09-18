#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"

# Match the host API's configuration without baking its token into JS or images.
for env_file in "$ROOT_DIR/.env.local" "$ROOT_DIR/services/api/.env.local"; do
    if [ -f "$env_file" ]; then
        set -a
        . "$env_file"
        set +a
    fi
done

if docker container inspect zenbar-api >/dev/null 2>&1; then
    export ZENBAR_API_UPSTREAM="${ZENBAR_API_UPSTREAM:-http://zenbar-api:8000}"
else
    export ZENBAR_API_UPSTREAM="${ZENBAR_API_UPSTREAM:-http://host.docker.internal:18000}"
fi
export ZENBAR_API_TOKEN="${ZENBAR_API_TOKEN:-}"
DASHBOARD_PORT="${ZENBAR_DOCKER_PORT:-8080}"

docker build -t zenbar-dashboard:local "$ROOT_DIR"
if ! docker network inspect zenbar >/dev/null 2>&1; then
    docker network create zenbar
fi
if docker container inspect zenbar-dashboard >/dev/null 2>&1; then
    docker rm -f zenbar-dashboard
fi
docker run -d --name zenbar-dashboard --restart unless-stopped --network zenbar \
    --add-host host.docker.internal:host-gateway \
    -p "127.0.0.1:$DASHBOARD_PORT:80" \
    --env ZENBAR_API_UPSTREAM --env ZENBAR_API_TOKEN \
    zenbar-dashboard:local
printf 'Dashboard: http://localhost:%s\n' "$DASHBOARD_PORT"
