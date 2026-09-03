#!/bin/sh
set -eu

target=${1:-infra/server/.env}
if [ -e "$target" ]; then
  echo "Refusing to overwrite existing $target" >&2
  exit 1
fi

umask 077
random_hex() {
  openssl rand -hex 32
}

postgres_owner_password=$(random_hex)
postgres_app_password=$(random_hex)
redis_password=$(random_hex)
webhook_secret=$(random_hex)
max_webhook_secret=$(random_hex)
crm_integration_token=${CRM_INTEGRATION_TOKEN_VALUE:-$(random_hex)}

telegram_token=${TELEGRAM_BOT_TOKEN_VALUE:-CHANGE_ME_BOTFATHER_TOKEN}
superadmin_ids=${SUPERADMIN_TELEGRAM_IDS_VALUE:-}
max_token=${MAX_BOT_TOKEN_VALUE:-}
max_bot_username=${MAX_BOT_USERNAME_VALUE:-}
superadmin_max_ids=${SUPERADMIN_MAX_IDS_VALUE:-}
artifacts_domain=${ARTIFACTS_DOMAIN_VALUE:-artifacts.62-113-105-225.sslip.io}
image_tag=${IMAGE_TAG_VALUE:-latest}
crm_api_url=${CRM_API_URL_VALUE:-https://crm.62-113-105-225.sslip.io/api}
s3_endpoint=${S3_ENDPOINT_VALUE:-https://s3.ru1.storage.beget.cloud}
s3_bucket=${S3_BUCKET_VALUE:-CHANGE_ME_SHARED_BUCKET}
s3_access_key=${S3_ACCESS_KEY_VALUE:-CHANGE_ME_ACCESS_KEY}
s3_secret_key=${S3_SECRET_KEY_VALUE:-CHANGE_ME_SECRET_KEY}

case "$s3_endpoint" in
  https://*) s3_upstream=${s3_endpoint#https://} ;;
  *)
    echo "S3_ENDPOINT_VALUE must be an https origin without a path" >&2
    exit 1
    ;;
esac
s3_upstream=${s3_upstream%/}
case "$s3_upstream" in
  ''|*/*|*'?'*|*'#'*|*'@'*|*[!A-Za-z0-9._:-]*)
    echo "S3_ENDPOINT_VALUE must be an https origin without credentials, path, query or fragment" >&2
    exit 1
    ;;
esac

{
  printf 'IMAGE_TAG=%s\n' "$image_tag"
  printf 'ARTIFACTS_DOMAIN=%s\n' "$artifacts_domain"
  printf 'POSTGRES_DB=artifacts\n'
  printf 'POSTGRES_USER=artifacts_owner\n'
  printf 'POSTGRES_PASSWORD=%s\n' "$postgres_owner_password"
  printf 'APP_DB_USER=artifacts_app\n'
  printf 'APP_DB_PASSWORD=%s\n' "$postgres_app_password"
  printf 'REDIS_PASSWORD=%s\n' "$redis_password"
  printf 'S3_ENDPOINT=%s\n' "$s3_endpoint"
  printf 'S3_UPSTREAM=%s\n' "$s3_upstream"
  printf 'S3_REGION=ru1\n'
  printf 'S3_BUCKET=%s\n' "$s3_bucket"
  printf 'S3_PREFIX=locker/\n'
  printf 'S3_ACCESS_KEY=%s\n' "$s3_access_key"
  printf 'S3_SECRET_KEY=%s\n' "$s3_secret_key"
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "$telegram_token"
  printf 'SUPERADMIN_TELEGRAM_IDS=%s\n' "$superadmin_ids"
  printf 'BOT_WEBHOOK_SECRET=%s\n' "$webhook_secret"
  printf 'MAX_BOT_TOKEN=%s\n' "$max_token"
  printf 'MAX_BOT_USERNAME=%s\n' "$max_bot_username"
  printf 'MAX_API_BASE=https://platform-api2.max.ru\n'
  printf 'MAX_AUTH_MAX_AGE_SECONDS=3600\n'
  printf 'SUPERADMIN_MAX_IDS=%s\n' "$superadmin_max_ids"
  printf 'MAX_WEBHOOK_PATH=/max/webhook\n'
  printf 'MAX_WEBHOOK_SECRET=%s\n' "$max_webhook_secret"
  printf 'LEADER_ID_ENABLED=false\n'
  printf 'LEADER_ID_ENVIRONMENT=production\n'
  printf 'LEADER_ID_CLIENT_ID=\n'
  printf 'LEADER_ID_CLIENT_SECRET=\n'
  printf 'LEADER_ID_SERVER_CLIENT_ID=\n'
  printf 'LEADER_ID_SERVER_CLIENT_SECRET=\n'
  printf 'LEADER_ID_TOKEN_ACTIVE_KEY_ID=\n'
  printf 'LEADER_ID_TOKEN_KEYRING=\n'
  printf 'LEADER_ID_OAUTH_SCOPE=\n'
  printf 'LEADER_ID_OAUTH_STATE_TTL_SECONDS=600\n'
  printf 'LEADER_ID_API_TIMEOUT_MS=10000\n'
  printf 'CRM_API_URL=%s\n' "$crm_api_url"
  printf 'CRM_INTEGRATION_TOKEN=%s\n' "$crm_integration_token"
  printf 'FILE_VERIFICATION_MODE=clamav\n'
  printf 'CLAMAV_HOST=clamav\n'
  printf 'CLAMAV_PORT=3310\n'
  printf 'CLAMAV_MEMORY_LIMIT=4g\n'
  printf 'CLAMAV_STREAM_MAX_LENGTH=2048M\n'
  printf 'CLAMAV_MAX_FILE_SIZE=2048M\n'
  printf 'CLAMAV_MAX_SCAN_SIZE=2048M\n'
  printf 'LOG_LEVEL=info\n'
} > "$target"

chmod 600 "$target"
echo "Production environment created at $target"
