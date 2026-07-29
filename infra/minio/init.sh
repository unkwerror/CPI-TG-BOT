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

case "$S3_QUARANTINE_BUCKET:$S3_PRIVATE_BUCKET:$S3_EXPORT_BUCKET" in
  *[!a-z0-9.:-]*)
    echo "Invalid S3 bucket name" >&2
    exit 1
    ;;
esac

# The minimal mc image intentionally has no sed/awk. Render the small policy
# with POSIX shell printf, keeping bucket names configurable.
printf '%s\n' \
  '{"Version":"2012-10-17","Statement":[' \
  '{"Effect":"Allow","Action":["s3:GetBucketLocation","s3:ListBucket","s3:ListBucketMultipartUploads"],"Resource":[' \
  "\"arn:aws:s3:::$S3_QUARANTINE_BUCKET\"," \
  "\"arn:aws:s3:::$S3_PRIVATE_BUCKET\"," \
  "\"arn:aws:s3:::$S3_EXPORT_BUCKET\"]}," \
  '{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:AbortMultipartUpload","s3:ListMultipartUploadParts"],"Resource":[' \
  "\"arn:aws:s3:::$S3_QUARANTINE_BUCKET/*\"," \
  "\"arn:aws:s3:::$S3_PRIVATE_BUCKET/*\"," \
  "\"arn:aws:s3:::$S3_EXPORT_BUCKET/*\"]}]}" \
  > /tmp/app-policy.json

mc admin user add local "$S3_ACCESS_KEY" "$S3_SECRET_KEY" 2>/dev/null || true
mc admin policy create local artifacts-app /tmp/app-policy.json 2>/dev/null || \
  mc admin policy update local artifacts-app /tmp/app-policy.json
mc admin policy attach local artifacts-app --user "$S3_ACCESS_KEY"

mc ilm rule add --expire-days 2 "local/$S3_QUARANTINE_BUCKET" 2>/dev/null || true
mc ilm rule add --expire-days 3 "local/$S3_EXPORT_BUCKET" 2>/dev/null || true
