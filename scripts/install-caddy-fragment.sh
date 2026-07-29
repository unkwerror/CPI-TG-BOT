#!/bin/sh
set -eu

fragment=${1:-infra/server/Caddyfile.fragment}
host_caddyfile=${2:-/opt/CPI-CRM-MVP/infra/server/Caddyfile}
caddy_container=${3:-cpi-crm-production-caddy-1}

: "${ARTIFACTS_DOMAIN:?ARTIFACTS_DOMAIN is required}"
: "${ARTIFACTS_S3_DOMAIN:?ARTIFACTS_S3_DOMAIN is required}"

case "$ARTIFACTS_DOMAIN:$ARTIFACTS_S3_DOMAIN" in
  *[!A-Za-z0-9._:-]*)
    echo "Invalid domain value" >&2
    exit 1
    ;;
esac

if grep -q '# BEGIN CPI ARTIFACTS' "$host_caddyfile"; then
  echo "CPI Artifacts Caddy fragment is already installed"
  exit 0
fi

backup="${host_caddyfile}.before-cpi-artifacts.$(date -u +%Y%m%dT%H%M%SZ)"
rendered=$(mktemp)
cp "$host_caddyfile" "$backup"
sed \
  -e "s|__ARTIFACTS_DOMAIN__|$ARTIFACTS_DOMAIN|g" \
  -e "s|__ARTIFACTS_S3_DOMAIN__|$ARTIFACTS_S3_DOMAIN|g" \
  "$fragment" > "$rendered"

{
  printf '\n'
  cat "$rendered"
} >> "$host_caddyfile"
rm -f "$rendered"

if ! docker exec "$caddy_container" caddy validate --config /etc/caddy/Caddyfile; then
  cp "$backup" "$host_caddyfile"
  echo "Caddy validation failed; original configuration restored from $backup" >&2
  exit 1
fi

docker exec "$caddy_container" caddy reload --config /etc/caddy/Caddyfile
echo "Caddy fragment installed; backup: $backup"
