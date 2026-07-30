import type { FastifyPluginAsync } from 'fastify';
import { inArray } from 'drizzle-orm';
import { artifacts } from '@cpi/db';
import { purgeArtifactStorage, type EventStoragePurgeResult } from './event-storage';

export interface StoredArtifactRow {
  id: string;
  bucket: string;
  objectKey: string;
  uploadId: string | null;
}

export async function deleteArtifactObjects(
  app: Parameters<FastifyPluginAsync>[0],
  rows: Iterable<StoredArtifactRow>,
): Promise<EventStoragePurgeResult> {
  const storedArtifacts = [...rows];
  if (storedArtifacts.length === 0) {
    return { deletedObjects: 0, abortedMultipartUploads: 0 };
  }
  const result = await purgeArtifactStorage(
    app.s3Internal,
    [app.config.S3_QUARANTINE_BUCKET, app.config.S3_PRIVATE_BUCKET],
    storedArtifacts,
  );
  await app.db
    .update(artifacts)
    .set({ uploadId: null, storageDeletedAt: new Date() })
    .where(
      inArray(
        artifacts.id,
        storedArtifacts.map((artifact) => artifact.id),
      ),
    );
  return result;
}
