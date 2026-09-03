import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLeaderIdRoutes, type LeaderIdRouteService } from './leader-id';

const state = 's'.repeat(43);
const catalystUserId = '00000000-0000-4000-8000-000000000001';

function serviceFixture() {
  const service = {
    beginLink: vi.fn(async () => ({ authorizationUrl: 'https://leader-id.ru/apps/authorize' })),
    cancelLink: vi.fn(async () => undefined),
    completeLink: vi.fn(async () => ({ catalystUserId, leaderIdUserId: 123456 })),
    subscribe: vi.fn(async () => {
      throw new Error('temporary Leader-ID failure');
    }),
    getStatus: vi.fn(async () => {
      throw new Error('getStatus is not expected in this test');
    }),
  } satisfies LeaderIdRouteService;
  return service;
}

const apps: FastifyInstance[] = [];

async function callbackApp(service: LeaderIdRouteService) {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorate('requireAuth', async () => undefined);
  app.decorate('requireCsrf', async () => undefined);
  await app.register(
    createLeaderIdRoutes({
      service,
      successRedirectUrl: 'https://catalyst.example/leader-id/complete',
      failureRedirectUrl: 'https://catalyst.example/leader-id/complete',
    }),
  );
  await app.ready();
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Leader-ID OAuth callback return', () => {
  it('redirects a completed binding and starts registration without exposing OAuth parameters', async () => {
    const service = serviceFixture();
    const app = await callbackApp(service);

    const response = await app.inject({
      method: 'GET',
      url: `/catalyst/leader-id/oauth/callback?state=${state}&code=authorization-code`,
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(
      'https://catalyst.example/leader-id/complete?leaderId=linked',
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers.location).not.toContain('authorization-code');
    expect(response.headers.location).not.toContain(state);
    expect(service.completeLink).toHaveBeenCalledOnce();
    expect(service.subscribe).toHaveBeenCalledWith(catalystUserId);
    expect(service.cancelLink).not.toHaveBeenCalled();
  });

  it('consumes a denied authorization state and redirects to the generic error page', async () => {
    const service = serviceFixture();
    const app = await callbackApp(service);

    const response = await app.inject({
      method: 'GET',
      url: `/catalyst/leader-id/oauth/callback?state=${state}&error=access_denied`,
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(
      'https://catalyst.example/leader-id/complete?leaderId=error',
    );
    expect(service.cancelLink).toHaveBeenCalledWith(state);
    expect(service.completeLink).not.toHaveBeenCalled();
  });

  it('fails closed without reflecting malformed callback input in the redirect', async () => {
    const service = serviceFixture();
    const app = await callbackApp(service);

    const response = await app.inject({
      method: 'GET',
      url: '/catalyst/leader-id/oauth/callback?state=bad&code=%3Cscript%3E',
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(
      'https://catalyst.example/leader-id/complete?leaderId=error',
    );
    expect(response.headers.location).not.toContain('script');
    expect(service.completeLink).not.toHaveBeenCalled();
  });

  it('rejects insecure or credential-bearing fixed redirect configuration', () => {
    const service = serviceFixture();
    expect(() =>
      createLeaderIdRoutes({
        service,
        successRedirectUrl: 'http://catalyst.example/leader-id/complete',
        failureRedirectUrl: 'https://catalyst.example/leader-id/complete',
      }),
    ).toThrow('must use HTTPS');
    expect(() =>
      createLeaderIdRoutes({
        service,
        successRedirectUrl: 'https://user:password@catalyst.example/leader-id/complete',
        failureRedirectUrl: 'https://catalyst.example/leader-id/complete',
      }),
    ).toThrow('cannot contain URL credentials');
  });
});
