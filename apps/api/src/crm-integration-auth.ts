import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AppError } from '@cpi/shared';

export function isCrmIntegrationAuthorizationValid(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  if (!authorization?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(authorization.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function requireCrmIntegration(expectedToken: string) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!isCrmIntegrationAuthorizationValid(request.headers.authorization, expectedToken)) {
      throw new AppError('CRM_INTEGRATION_UNAUTHORIZED', 'Интеграция CRM не авторизована', 401);
    }
  };
}
