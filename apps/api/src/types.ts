import type { ApiEnvironment } from '@cpi/config';
import type { Database } from '@cpi/db';
import type { RoleName } from '@cpi/shared';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Queue } from 'bullmq';
import type { FastifyReply } from 'fastify';
import type Redis from 'ioredis';

export interface SessionData {
  id: string;
  userId: string;
  csrfToken: string;
  createdAt: string;
}

export interface AuthenticatedUser {
  id: string;
  telegramUserId: bigint;
  telegramUsername: string | null;
  fullName: string | null;
  organization: string | null;
  position: string | null;
  phone: string | null;
  consentAt: Date | null;
  status: 'active' | 'blocked';
  roles: RoleName[];
}

declare module 'fastify' {
  interface FastifyInstance {
    config: ApiEnvironment;
    db: Database;
    redis: Redis;
    s3Internal: S3Client;
    s3Public: S3Client;
    artifactQueue: Queue;
    exportQueue: Queue;
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireCsrf: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireSuperadmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    currentUser?: AuthenticatedUser;
    session?: SessionData;
  }
}
