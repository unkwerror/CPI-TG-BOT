#!/bin/sh
set -eu

# Пишет фрагмент бота в conf.d CRM Caddy, чтобы очередной выкат CRM не затирал
# маршруты бота. Старый путь через правку самого Caddyfile больше не нужен.
fragment=${1:-infra/server/Caddyfile.fragment}
conf_dir=${2:-/opt/CPI-CRM-MVP/infra/server/conf.d}
caddy_container=${3:-cpi-crm-production-caddy-1}
caddy_network=${4:-cpi-artifacts-caddy}
target="${conf_dir}/10-cpi-artifacts.caddy"

: "${ARTIFACTS_DOMAIN:?ARTIFACTS_DOMAIN is required}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_UPSTREAM:?S3_UPSTREAM is required}"

case "$S3_ENDPOINT" in
  https://*) derived_s3_upstream=${S3_ENDPOINT#https://} ;;
  *)
    echo "S3_ENDPOINT must be an https origin without a path" >&2
    exit 1
    ;;
esac
derived_s3_upstream=${derived_s3_upstream%/}
if [ "$S3_UPSTREAM" != "$derived_s3_upstream" ]; then
  echo "S3_UPSTREAM must exactly match the host derived from S3_ENDPOINT" >&2
  exit 1
fi

case "$ARTIFACTS_DOMAIN:$S3_UPSTREAM:$caddy_network" in
  *[!A-Za-z0-9._:-]*)
    echo "Invalid domain, upstream or network value" >&2
    exit 1
    ;;
esac

if ! docker network inspect "$caddy_network" >/dev/null 2>&1; then
  docker network create "$caddy_network" >/dev/null
fi

if ! docker inspect "$caddy_container" \
  --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' |
  grep -Fxq "$caddy_network"; then
  docker network connect "$caddy_network" "$caddy_container"
fi

mkdir -p "$conf_dir"
backup="${target}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
if [ -e "$target" ]; then
  cp "$target" "$backup"
fi

sed \
  -e "s|__ARTIFACTS_DOMAIN__|$ARTIFACTS_DOMAIN|g" \
  -e "s|__S3_UPSTREAM__|$S3_UPSTREAM|g" \
  "$fragment" > "$target"

if ! docker exec "$caddy_container" caddy validate --config /etc/caddy/Caddyfile; then
  if [ -e "$backup" ]; then
    cat "$backup" > "$target"
  else
    rm -f "$target"
  fi
  echo "Caddy validation failed; previous fragment restored" >&2
  exit 1
fi

docker exec "$caddy_container" caddy reload --config /etc/caddy/Caddyfile
echo "Caddy fragment installed at $target; network: $caddy_network"
