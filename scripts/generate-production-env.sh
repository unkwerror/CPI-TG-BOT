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
minio_root_password=$(random_hex)
s3_secret=$(random_hex)
webhook_secret=$(random_hex)
crm_integration_token=${CRM_INTEGRATION_TOKEN_VALUE:-$(random_hex)}

telegram_token=${TELEGRAM_BOT_TOKEN_VALUE:-CHANGE_ME_BOTFATHER_TOKEN}
superadmin_ids=${SUPERADMIN_TELEGRAM_IDS_VALUE:-}
artifacts_domain=${ARTIFACTS_DOMAIN_VALUE:-artifacts.62-113-105-225.sslip.io}
artifacts_s3_domain=${ARTIFACTS_S3_DOMAIN_VALUE:-uploads-artifacts.62-113-105-225.sslip.io}
image_tag=${IMAGE_TAG_VALUE:-latest}
crm_api_url=${CRM_API_URL_VALUE:-https://crm.62-113-105-225.sslip.io/api}

{
  printf 'IMAGE_TAG=%s\n' "$image_tag"
  printf 'ARTIFACTS_DOMAIN=%s\n' "$artifacts_domain"
  printf 'ARTIFACTS_S3_DOMAIN=%s\n' "$artifacts_s3_domain"
  printf 'POSTGRES_DB=artifacts\n'
  printf 'POSTGRES_USER=artifacts_owner\n'
  printf 'POSTGRES_PASSWORD=%s\n' "$postgres_owner_password"
  printf 'APP_DB_USER=artifacts_app\n'
  printf 'APP_DB_PASSWORD=%s\n' "$postgres_app_password"
  printf 'REDIS_PASSWORD=%s\n' "$redis_password"
  printf 'MINIO_ROOT_USER=artifacts_root\n'
  printf 'MINIO_ROOT_PASSWORD=%s\n' "$minio_root_password"
  printf 'S3_ACCESS_KEY=artifacts_app\n'
  printf 'S3_SECRET_KEY=%s\n' "$s3_secret"
  printf 'S3_REGION=us-east-1\n'
  printf 'S3_QUARANTINE_BUCKET=artifacts-quarantine\n'
  printf 'S3_PRIVATE_BUCKET=artifacts-private\n'
  printf 'S3_EXPORT_BUCKET=artifacts-exports\n'
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "$telegram_token"
  printf 'SUPERADMIN_TELEGRAM_IDS=%s\n' "$superadmin_ids"
  printf 'BOT_WEBHOOK_SECRET=%s\n' "$webhook_secret"
  printf 'CRM_API_URL=%s\n' "$crm_api_url"
  printf 'CRM_INTEGRATION_TOKEN=%s\n' "$crm_integration_token"
  printf 'FILE_VERIFICATION_MODE=metadata-only\n'
  printf 'LOG_LEVEL=info\n'
} > "$target"

chmod 600 "$target"
echo "Production environment created at $target"
