#!/bin/sh
set -eu

until mc alias set local "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"; do
  sleep 2
done

mc mb --ignore-existing "local/$S3_QUARANTINE_BUCKET"
mc mb --ignore-existing "local/$S3_PRIVATE_BUCKET"
mc mb --ignore-existing "local/$S3_EXPORT_BUCKET"
mc anonymous set none "local/$S3_QUARANTINE_BUCKET"
mc anonymous set none "local/$S3_PRIVATE_BUCKET"
mc anonymous set none "local/$S3_EXPORT_BUCKET"

sed \
  -e "s/__QUARANTINE_BUCKET__/$S3_QUARANTINE_BUCKET/g" \
  -e "s/__PRIVATE_BUCKET__/$S3_PRIVATE_BUCKET/g" \
  -e "s/__EXPORT_BUCKET__/$S3_EXPORT_BUCKET/g" \
  /config/app-policy.json > /tmp/app-policy.json

mc admin user add local "$S3_ACCESS_KEY" "$S3_SECRET_KEY" 2>/dev/null || true
mc admin policy create local artifacts-app /tmp/app-policy.json 2>/dev/null || \
  mc admin policy update local artifacts-app /tmp/app-policy.json
mc admin policy attach local artifacts-app --user "$S3_ACCESS_KEY"

mc ilm rule add --expire-days 2 "local/$S3_QUARANTINE_BUCKET" 2>/dev/null || true
mc ilm rule add --expire-days 3 "local/$S3_EXPORT_BUCKET" 2>/dev/null || true
