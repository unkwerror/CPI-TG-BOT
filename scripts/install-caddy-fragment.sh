#!/bin/sh
set -eu

fragment=${1:-infra/server/Caddyfile.fragment}
host_caddyfile=${2:-/opt/CPI-CRM-MVP/infra/server/Caddyfile}
caddy_container=${3:-cpi-crm-production-caddy-1}
caddy_network=${4:-cpi-artifacts-caddy}

: "${ARTIFACTS_DOMAIN:?ARTIFACTS_DOMAIN is required}"
: "${ARTIFACTS_S3_DOMAIN:?ARTIFACTS_S3_DOMAIN is required}"

case "$ARTIFACTS_DOMAIN:$ARTIFACTS_S3_DOMAIN:$caddy_network" in
  *[!A-Za-z0-9._:-]*)
    echo "Invalid domain or network value" >&2
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

backup="${host_caddyfile}.before-cpi-artifacts.$(date -u +%Y%m%dT%H%M%SZ)"
rendered=$(mktemp)
merged=$(mktemp)
trap 'rm -f "$rendered" "$merged"' EXIT
cp "$host_caddyfile" "$backup"
sed \
  -e "s|__ARTIFACTS_DOMAIN__|$ARTIFACTS_DOMAIN|g" \
  -e "s|__ARTIFACTS_S3_DOMAIN__|$ARTIFACTS_S3_DOMAIN|g" \
  "$fragment" > "$rendered"

if grep -q '# BEGIN CPI ARTIFACTS' "$host_caddyfile"; then
  awk -v replacement="$rendered" '
    /^# BEGIN CPI ARTIFACTS$/ {
      while ((getline line < replacement) > 0) print line
      close(replacement)
      inside = 1
      next
    }
    /^# END CPI ARTIFACTS$/ && inside {
      inside = 0
      next
    }
    !inside { print }
  ' "$host_caddyfile" > "$merged"
else
  {
    cat "$host_caddyfile"
    printf '\n'
    cat "$rendered"
  } > "$merged"
fi
# Preserve the inode: production Caddy bind-mounts this file read-only, and
# replacing it with mv would leave the running container on the old inode.
cat "$merged" > "$host_caddyfile"

if ! docker exec "$caddy_container" caddy validate --config /etc/caddy/Caddyfile; then
  cat "$backup" > "$host_caddyfile"
  echo "Caddy validation failed; original configuration restored from $backup" >&2
  exit 1
fi

docker exec "$caddy_container" caddy reload --config /etc/caddy/Caddyfile
echo "Caddy fragment installed or updated; backup: $backup; network: $caddy_network"
