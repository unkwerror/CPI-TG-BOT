import { describe, expect, it, vi } from 'vitest';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { createSession, destroySession } from './auth';

type App = Parameters<FastifyPluginAsync>[0];

function appFor(environment: 'development' | 'production') {
  const redis = {
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  };
  const app = {
    config: {
      NODE_ENV: environment,
      SESSION_TTL_SECONDS: 3_600,
      SESSION_COOKIE_NAME: 'session',
      COOKIE_DOMAIN: environment === 'production' ? 'example.test' : undefined,
    },
    redis,
  } as unknown as App;
  return { app, redis };
}

function replyMock() {
  const reply = {
    setCookie: vi.fn(),
    clearCookie: vi.fn(),
  };
  return { reply: reply as unknown as FastifyReply, spies: reply };
}

describe('session cookie settings', () => {
  it('allows the secure production cookie inside Telegram desktop frames', async () => {
    const { app } = appFor('production');
    const { reply, spies } = replyMock();

    await createSession(app, reply, 'user-id');

    expect(spies.setCookie).toHaveBeenCalledWith(
      'session',
      expect.any(String),
      expect.objectContaining({
        domain: 'example.test',
        httpOnly: true,
        maxAge: 3_600,
        path: '/',
        sameSite: 'none',
        secure: true,
      }),
    );
  });

  it('keeps local development cookies usable over HTTP', async () => {
    const { app } = appFor('development');
    const { reply, spies } = replyMock();

    await createSession(app, reply, 'user-id');

    expect(spies.setCookie).toHaveBeenCalledWith(
      'session',
      expect.any(String),
      expect.objectContaining({ sameSite: 'lax', secure: false }),
    );
  });

  it('clears the cookie with the same production attributes', async () => {
    const { app, redis } = appFor('production');
    const { reply, spies } = replyMock();

    await destroySession(app, reply, 'session-id');

    expect(redis.del).toHaveBeenCalledWith('session:session-id');
    expect(spies.clearCookie).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({
        domain: 'example.test',
        path: '/',
        sameSite: 'none',
        secure: true,
      }),
    );
  });
});
