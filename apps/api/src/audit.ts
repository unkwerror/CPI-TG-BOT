import type { FastifyRequest } from 'fastify';
import { auditLogs } from '@cpi/db';

export async function writeAudit(
  request: FastifyRequest,
  input: {
    action: string;
    entityType: string;
    entityId?: string;
    eventId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await request.server.db.insert(auditLogs).values({
    actorUserId: request.currentUser?.id ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    eventId: input.eventId ?? null,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent']?.slice(0, 500) ?? null,
    metadata: input.metadata ?? {},
  });
}
