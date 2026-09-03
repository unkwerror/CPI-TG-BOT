/**
 * Одноразовая миграция файлов бота из локального MinIO в общий облачный бакет.
 *
 * Запускать на сервере до выката нового compose: MinIO ещё должен работать,
 * а креды Beget уже известны. Скрипт копирует готовые файлы в
 * `locker/artifacts/<Мероприятие>/<Участник>/`, обновляет bucket/object_key в
 * базе и обнуляет ссылки на старые выгрузки.
 *
 * Пример:
 *   MIGRATION_QUIESCED=1 node --env-file=infra/server/.env.migration \
 *     scripts/migrate-storage-to-beget.mjs
 */

/* global console, process */

import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';
import { copyObjectStreaming } from './storage-migration-helpers.mjs';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const source = new S3Client({
  endpoint: required('SOURCE_S3_ENDPOINT'),
  region: process.env.SOURCE_S3_REGION ?? 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: required('SOURCE_S3_ACCESS_KEY'),
    secretAccessKey: required('SOURCE_S3_SECRET_KEY'),
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const target = new S3Client({
  endpoint: required('TARGET_S3_ENDPOINT'),
  region: process.env.TARGET_S3_REGION ?? 'ru1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: required('TARGET_S3_ACCESS_KEY'),
    secretAccessKey: required('TARGET_S3_SECRET_KEY'),
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const targetBucket = required('TARGET_S3_BUCKET');
const prefix = (process.env.TARGET_S3_PREFIX ?? 'locker/').replace(/^\/+|\/+$/g, '');
if (prefix !== 'locker') {
  throw new Error('TARGET_S3_PREFIX must resolve exactly to locker/ for the production cutover');
}
const dryRun = process.env.DRY_RUN === '1';
if (process.env.MIGRATION_QUIESCED !== '1') {
  throw new Error(
    'Set MIGRATION_QUIESCED=1 only after API and worker writes have been stopped for the cutover',
  );
}

// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f/\\:*?"<>|]/gu;

function sanitizePathSegment(value, fallback = 'без названия') {
  const cleaned = String(value ?? '')
    .normalize('NFC')
    .replace(UNSAFE, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^[.\s]+/u, '')
    .replace(/[.\s]+$/u, '');
  if (!cleaned) return fallback;
  return cleaned.length > 80 ? cleaned.slice(0, 80).trim() : cleaned;
}

function sanitizeFileName(value, fallback = 'файл') {
  const cleaned = String(value ?? '')
    .normalize('NFC')
    .replace(UNSAFE, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned) return fallback;
  const dot = cleaned.lastIndexOf('.');
  const hasExtension = dot > 0 && dot < cleaned.length - 1 && cleaned.length - dot <= 12;
  const base = hasExtension ? cleaned.slice(0, dot) : cleaned;
  const extension = hasExtension ? cleaned.slice(dot).toLowerCase() : '';
  const safeBase = sanitizePathSegment(base, fallback).slice(0, 80);
  return `${safeBase || fallback}${extension}`;
}

function withCopySuffix(objectKey, attempt) {
  if (attempt <= 1) return objectKey;
  const slash = objectKey.lastIndexOf('/');
  const directory = objectKey.slice(0, slash + 1);
  const name = objectKey.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const hasExtension = dot > 0 && dot < name.length - 1 && name.length - dot <= 12;
  const base = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : '';
  return `${directory}${base} (${String(attempt)})${extension}`;
}

function artifactObjectKey(row) {
  const event = sanitizePathSegment(row.event_title, 'Без мероприятия');
  const person = sanitizePathSegment(row.full_name, `Без имени ${String(row.telegram_user_id)}`);
  return `${prefix}/artifacts/${event}/${person}/${sanitizeFileName(row.display_name)}`;
}

async function headTarget(key) {
  try {
    return await target.send(new HeadObjectCommand({ Bucket: targetBucket, Key: key }));
  } catch (error) {
    if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) return undefined;
    throw error;
  }
}

async function findFreeKey(desired, taken, artifactId) {
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = withCopySuffix(desired, attempt);
    if (taken.has(candidate)) continue;
    const owner = await pool.query('SELECT id FROM artifacts WHERE object_key = $1 LIMIT 1', [
      candidate,
    ]);
    if (owner.rows[0]?.id && owner.rows[0].id !== artifactId) continue;
    const head = await headTarget(candidate);
    if (!head || head.Metadata?.artifact === artifactId) return candidate;
  }
  throw new Error(`No free key for ${desired}`);
}

const pool = new pg.Pool({ connectionString: required('DATABASE_URL') });

async function assertStorageWritesQuiesced() {
  const { rows } = await pool.query(`
    SELECT 'artifact' AS kind, status::text AS status, count(*)::int AS count
      FROM artifacts
     WHERE deleted_at IS NULL
       AND status IN ('created', 'uploading', 'uploaded', 'verifying', 'failed')
     GROUP BY status
    UNION ALL
    SELECT 'export' AS kind, status::text AS status, count(*)::int AS count
      FROM export_jobs
     WHERE status IN ('queued', 'processing')
     GROUP BY status
  `);
  if (rows.length > 0) {
    const details = rows.map((row) => `${row.kind}:${row.status}=${row.count}`).join(', ');
    throw new Error(
      `Storage migration preflight failed: non-terminal work exists (${details}). Stop API/worker and finish or cancel it before retrying.`,
    );
  }
}

async function assertNoUnsupportedLegacyObjects() {
  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS count
       FROM artifacts
      WHERE storage_deleted_at IS NULL
        AND status IN ('quarantined', 'deleted')
        AND (bucket <> $1 OR object_key NOT LIKE $2)
      GROUP BY status`,
    [targetBucket, `${prefix}/%`],
  );
  if (rows.length > 0) {
    const details = rows.map((row) => `${row.status}=${row.count}`).join(', ');
    throw new Error(
      `Storage migration preflight failed: terminal legacy objects need explicit cleanup (${details})`,
    );
  }
}

async function assertNoReadyLegacyObjects() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count
       FROM artifacts
      WHERE status = 'ready'
        AND deleted_at IS NULL
        AND (bucket <> $1 OR object_key NOT LIKE $2)`,
    [targetBucket, `${prefix}/artifacts/%`],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (count > 0) {
    throw new Error(`Storage cutover invariant failed: ${count} ready artifacts remain legacy`);
  }
}

async function assertNoLegacyExports() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count
       FROM export_jobs
      WHERE (bucket IS NULL) IS DISTINCT FROM (object_key IS NULL)
         OR (
           object_key IS NOT NULL
           AND (bucket IS DISTINCT FROM $1 OR object_key NOT LIKE $2)
         )`,
    [targetBucket, `${prefix}/exports/%`],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (count > 0) {
    throw new Error(`Storage cutover invariant failed: ${count} exports remain legacy`);
  }
}

try {
  await assertStorageWritesQuiesced();
  await assertNoUnsupportedLegacyObjects();
  const { rows } = await pool.query(
    `
    SELECT a.id, a.submission_id, a.bucket, a.object_key, a.display_name, a.mime_type,
           a.checksum_sha256, a.actual_size_bytes, a.size_bytes, a.status,
           e.title AS event_title, u.full_name,
           u.telegram_user_id::text AS telegram_user_id
      FROM artifacts a
      JOIN events e ON e.id = a.event_id
      JOIN users u ON u.id = a.user_id
     WHERE a.status = 'ready'
       AND a.deleted_at IS NULL
       AND (a.bucket <> $2 OR a.object_key NOT LIKE $1)
     ORDER BY a.created_at
  `,
    [`${prefix}/artifacts/%`, targetBucket],
  );

  console.log(`Ready artifacts to migrate: ${rows.length}`);
  const taken = new Set();
  let migrated = 0;

  for (const row of rows) {
    const desired = artifactObjectKey(row);
    const destinationKey = await findFreeKey(desired, taken, row.id);
    taken.add(destinationKey);
    const copied = await copyObjectStreaming({
      source,
      target,
      targetBucket,
      row,
      destinationKey,
      dryRun,
    });
    if (dryRun) {
      console.log(`[dry-run] ${row.id} -> ${destinationKey} (${copied.sizeBytes} bytes)`);
    }
    if (!dryRun) {
      let updated;
      try {
        updated = await pool.query(
          `UPDATE artifacts
            SET bucket = $2,
                object_key = $3,
                checksum_sha256 = $6,
                actual_size_bytes = $7,
                etag = $8,
                updated_at = now()
          WHERE id = $1
            AND status = 'ready'
            AND deleted_at IS NULL
            AND bucket = $4
            AND object_key = $5
        RETURNING id`,
          [
            row.id,
            targetBucket,
            destinationKey,
            row.bucket,
            row.object_key,
            copied.checksumSha256,
            copied.sizeBytes,
            copied.etag,
          ],
        );
      } catch (error) {
        await target.send(new DeleteObjectCommand({ Bucket: targetBucket, Key: destinationKey }));
        throw error;
      }
      if (updated.rowCount !== 1) {
        await target.send(new DeleteObjectCommand({ Bucket: targetBucket, Key: destinationKey }));
        throw new Error(
          `Artifact ${row.id} changed after preflight; copied target was removed and the migration stopped`,
        );
      }
    }
    migrated += 1;
    console.log(`${migrated}/${rows.length} ${row.id} -> ${destinationKey}`);
  }

  if (!dryRun) {
    // Catch a process that ignored the operational stop after the initial preflight.
    await assertStorageWritesQuiesced();
    await assertNoUnsupportedLegacyObjects();
    await assertNoReadyLegacyObjects();
    const expired = await pool.query(
      `
      UPDATE export_jobs
         SET status = 'expired',
             expires_at = now(),
             error_message = 'Недействительна после переезда хранилища',
             bucket = null,
             object_key = null,
             size_bytes = null
       WHERE (bucket IS NOT NULL AND object_key IS NULL)
          OR (
            object_key IS NOT NULL
            AND (bucket IS DISTINCT FROM $1 OR object_key NOT LIKE $2)
          )
    `,
      [targetBucket, `${prefix}/exports/%`],
    );
    console.log(`Expired export jobs: ${expired.rowCount}`);
    await assertNoLegacyExports();
  }

  console.log(dryRun ? 'Dry run finished' : `Migrated ${migrated} artifacts`);
} finally {
  await pool.end();
  source.destroy();
  target.destroy();
}
