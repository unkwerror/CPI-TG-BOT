import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '@cpi/shared';
import { parseLeaderIdUserId } from '../leader-id-contract';
import type { LeaderIdStatusSnapshot, LeaderIdSubscriptionSummary } from '../leader-id-contract';

const bindBodySchema = z.object({ leaderId: z.union([z.string(), z.number()]) }).strict();
const callbackQuerySchema = z
  .object({
    code: z.string().min(1).max(4_096).optional(),
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    error: z.string().max(128).optional(),
  })
  .strict();

export interface LeaderIdRouteService {
  beginLink(input: {
    catalystUserId: string;
    expectedLeaderIdUserId: number;
  }): Promise<{ authorizationUrl: string }>;
  cancelLink(state: string): Promise<void>;
  completeLink(input: {
    state: string;
    code: string;
  }): Promise<{ catalystUserId: string; leaderIdUserId: number }>;
  subscribe(catalystUserId: string): Promise<LeaderIdSubscriptionSummary>;
  getStatus(catalystUserId: string): Promise<LeaderIdStatusSnapshot>;
}

export interface LeaderIdRouteOptions {
  service: LeaderIdRouteService;
  successRedirectUrl: string;
  failureRedirectUrl: string;
  onLinked?: (catalystUserId: string) => Promise<void>;
}

function validateFixedRedirect(value: string): string {
  const url = new URL(value);
  const localHttp =
    url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error('Leader-ID callback redirect must use HTTPS (except localhost)');
  }
  if (url.username || url.password) {
    throw new Error('Leader-ID callback redirect cannot contain URL credentials');
  }
  return url.toString();
}

function callbackRedirect(base: string, result: 'linked' | 'error'): string {
  const url = new URL(base);
  url.searchParams.set('leaderId', result);
  return url.toString();
}

/** Routes are factory-created so credentials and persistence adapters never decorate Fastify. */
export function createLeaderIdRoutes(options: LeaderIdRouteOptions): FastifyPluginAsync {
  const successRedirectUrl = validateFixedRedirect(options.successRedirectUrl);
  const failureRedirectUrl = validateFixedRedirect(options.failureRedirectUrl);

  return async (app) => {
    const subscriptionTasks = new Set<Promise<void>>();

    const subscribeAfterLink = (catalystUserId: string) => {
      const task = options.service
        .subscribe(catalystUserId)
        .then(() => undefined)
        .catch((error: unknown) => {
          app.log.warn(
            {
              errorCode: error instanceof AppError ? error.code : 'LEADER_ID_AUTO_SUBSCRIBE_FAILED',
            },
            'Leader-ID automatic subscription failed; startup reconciliation will retry it',
          );
        });
      subscriptionTasks.add(task);
      void task.then(() => subscriptionTasks.delete(task));
    };

    app.addHook('onClose', async () => {
      await Promise.allSettled(subscriptionTasks);
    });

    app.get(
      '/catalyst/leader-id/status',
      {
        preHandler: app.requireAuth,
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
        schema: { tags: ['leader-id'] },
      },
      async (request) => options.service.getStatus(request.currentUser!.id),
    );

    app.post(
      '/catalyst/leader-id/bind',
      {
        preHandler: [app.requireAuth, app.requireCsrf],
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: { tags: ['leader-id'] },
      },
      async (request) => {
        const body = bindBodySchema.parse(request.body);
        return options.service.beginLink({
          catalystUserId: request.currentUser!.id,
          expectedLeaderIdUserId: parseLeaderIdUserId(body.leaderId),
        });
      },
    );

    // OAuth codes and state must not appear in normal request logs. State is single-use and binds
    // the callback to the Catalyst user, so this cross-site redirect does not use cookie auth/CSRF.
    app.get(
      '/catalyst/leader-id/oauth/callback',
      {
        logLevel: 'silent',
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
        schema: { tags: ['leader-id'], hide: true },
      },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        reply.header('Referrer-Policy', 'no-referrer');
        try {
          const query = callbackQuerySchema.parse(request.query);
          if (query.error || !query.code) {
            await options.service.cancelLink(query.state);
            return reply.code(303).redirect(callbackRedirect(failureRedirectUrl, 'error'));
          }
          const linked = await options.service.completeLink({
            state: query.state,
            code: query.code,
          });
          if (options.onLinked) {
            try {
              await options.onLinked(linked.catalystUserId);
            } catch {
              app.log.warn(
                {
                  errorCode: 'LEADER_ID_TELEGRAM_INVITE_ENQUEUE_FAILED',
                },
                'Leader-ID Telegram chat invitation could not be queued; startup reconciliation will retry it',
              );
            }
          }
          subscribeAfterLink(linked.catalystUserId);
          return reply.code(303).redirect(callbackRedirect(successRedirectUrl, 'linked'));
        } catch (error) {
          app.log.warn(
            {
              errorCode: error instanceof AppError ? error.code : 'LEADER_ID_CALLBACK_FAILED',
            },
            'Leader-ID OAuth callback failed',
          );
          return reply.code(303).redirect(callbackRedirect(failureRedirectUrl, 'error'));
        }
      },
    );

    app.post(
      '/catalyst/leader-id/subscribe',
      {
        preHandler: [app.requireAuth, app.requireCsrf],
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
        schema: { tags: ['leader-id'] },
      },
      async (request) => options.service.subscribe(request.currentUser!.id),
    );
  };
}
