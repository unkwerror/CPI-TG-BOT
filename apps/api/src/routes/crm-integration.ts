import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { artifacts } from '@cpi/db';
import { AppError } from '@cpi/shared';
import { requireCrmIntegration } from '../crm-integration-auth';

const artifactParams = z.object({ artifactId: z.uuid() });

export const crmIntegrationRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/integrations/crm/artifacts/:artifactId/download',
    {
      preHandler: requireCrmIntegration(app.config.CRM_INTEGRATION_TOKEN),
      config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
      schema: { tags: ['integrations'] },
    },
    async (request) => {
      const { artifactId } = artifactParams.parse(request.params);
      const [artifact] = await app.db
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.id, artifactId),
            eq(artifacts.status, 'ready'),
            isNull(artifacts.deletedAt),
          ),
        )
        .limit(1);
      if (!artifact) throw new AppError('ARTIFACT_NOT_FOUND', 'Файл не найден', 404);

      const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(artifact.displayName)}`;
      const url = await getSignedUrl(
        app.s3Public,
        new GetObjectCommand({
          Bucket: artifact.bucket,
          Key: artifact.objectKey,
          ResponseContentType: artifact.mimeType,
          ResponseContentDisposition: disposition,
          ResponseCacheControl: 'private, no-store, max-age=0',
        }),
        { expiresIn: app.config.PRESIGNED_URL_TTL_SECONDS },
      );
      return { url, expiresInSeconds: app.config.PRESIGNED_URL_TTL_SECONDS };
    },
  );
};
