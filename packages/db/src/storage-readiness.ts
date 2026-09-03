import { sql } from 'drizzle-orm';
import type { Database } from './client';

function firstCount(result: { rows?: Array<{ count?: unknown }> }): number {
  return Number(result.rows?.[0]?.count ?? 0);
}

/**
 * Fail readiness while persisted references still point outside the post-cutover namespace.
 * Cleanup code deliberately trusts each row's bucket; this invariant makes a missing migration
 * visible instead of letting a new deployment quietly strand legacy objects.
 */
export async function assertStorageCutoverInvariant(
  db: Database,
  targetBucket: string,
  storagePrefix: string,
): Promise<void> {
  const [artifactResult, exportResult] = await Promise.all([
    db.execute(sql`
      SELECT count(*)::int AS count
        FROM artifacts
       WHERE storage_deleted_at IS NULL
         AND (
           bucket IS DISTINCT FROM ${targetBucket}
           OR object_key NOT LIKE ${`${storagePrefix}%`}
           OR (status = 'ready' AND object_key NOT LIKE ${`${storagePrefix}artifacts/%`})
         )
    `),
    db.execute(sql`
      SELECT count(*)::int AS count
        FROM export_jobs
       WHERE (bucket IS NULL) IS DISTINCT FROM (object_key IS NULL)
          OR (
            object_key IS NOT NULL
            AND (
              bucket IS DISTINCT FROM ${targetBucket}
              OR object_key NOT LIKE ${`${storagePrefix}exports/%`}
            )
          )
    `),
  ]);
  const artifactsOutsideCutover = firstCount(artifactResult);
  const exportsOutsideCutover = firstCount(exportResult);
  if (artifactsOutsideCutover > 0 || exportsOutsideCutover > 0) {
    throw new Error(
      `Storage cutover incomplete: artifacts=${artifactsOutsideCutover}, exports=${exportsOutsideCutover}`,
    );
  }
}
