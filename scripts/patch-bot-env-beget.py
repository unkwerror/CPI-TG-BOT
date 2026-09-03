#!/usr/bin/env python3
from pathlib import Path
import sys
from urllib.parse import urlsplit

bot = Path(sys.argv[1])
crm = Path(sys.argv[2])
crm_vars = {}
for line in crm.read_text().splitlines():
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, _, value = line.partition("=")
    crm_vars[key] = value

needed = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"]
missing = [key for key in needed if key not in crm_vars]
if missing:
    raise SystemExit(f"missing in CRM env: {missing}")

endpoint = urlsplit(crm_vars["S3_ENDPOINT"])
if (
    endpoint.scheme != "https"
    or not endpoint.netloc
    or endpoint.username
    or endpoint.password
    or endpoint.path not in ("", "/")
    or endpoint.query
    or endpoint.fragment
):
    raise SystemExit("S3_ENDPOINT must be an https origin without credentials, path, query or fragment")
s3_upstream = endpoint.netloc
if "S3_UPSTREAM" in crm_vars and crm_vars["S3_UPSTREAM"] != s3_upstream:
    raise SystemExit("S3_UPSTREAM does not match the host derived from S3_ENDPOINT")

skip = {
    "ARTIFACTS_S3_DOMAIN",
    "MINIO_ROOT_USER",
    "MINIO_ROOT_PASSWORD",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "S3_REGION",
    "S3_QUARANTINE_BUCKET",
    "S3_PRIVATE_BUCKET",
    "S3_EXPORT_BUCKET",
    "S3_ENDPOINT",
    "S3_UPSTREAM",
    "S3_BUCKET",
    "S3_PREFIX",
    "S3_PUBLIC_BASE",
    "S3_FORCE_PATH_STYLE",
    "S3_INTERNAL_ENDPOINT",
    "S3_PUBLIC_ENDPOINT",
}

lines = []
for line in bot.read_text().splitlines():
    key = line.split("=", 1)[0] if "=" in line else ""
    if key in skip:
        continue
    lines.append(line)

insert = [
    f"S3_ENDPOINT={crm_vars['S3_ENDPOINT']}",
    f"S3_UPSTREAM={s3_upstream}",
    f"S3_REGION={crm_vars['S3_REGION']}",
    f"S3_BUCKET={crm_vars['S3_BUCKET']}",
    "S3_PREFIX=locker/",
    f"S3_ACCESS_KEY={crm_vars['S3_ACCESS_KEY']}",
    f"S3_SECRET_KEY={crm_vars['S3_SECRET_KEY']}",
]

out = []
inserted = False
for line in lines:
    out.append(line)
    if line.startswith("ARTIFACTS_DOMAIN=") and not inserted:
        out.extend(insert)
        inserted = True
if not inserted:
    out.extend(insert)

bot.write_text("\n".join(out) + "\n")
print("env updated")
