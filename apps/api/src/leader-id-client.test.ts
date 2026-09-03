import { describe, expect, it, vi } from 'vitest';
import {
  LEADER_ID_APPS_PRODUCTION_BASE_URL,
  LeaderIdApiError,
  OfficialLeaderIdClient,
  type LeaderIdAppsBaseUrl,
} from './leader-id-client';

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function requestUrl(input: URL | RequestInfo): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}

function requestBody(input: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof input !== 'string') throw new Error('Expected a JSON string request body');
  return JSON.parse(input) as Record<string, unknown>;
}

describe('official Leader-ID Apps v1 client', () => {
  it('builds an authorization-code URL with fixed official origin and state', () => {
    const client = new OfficialLeaderIdClient({ fetch: vi.fn() as unknown as typeof fetch });
    const url = new URL(
      client.createAuthorizationUrl({
        clientId: 'client-id',
        redirectUri: 'https://catalyst.example/api/v1/catalyst/leader-id/oauth/callback',
        state: Buffer.alloc(32, 4).toString('base64url'),
      }),
    );

    expect(url.origin).toBe('https://leader-id.ru');
    expect(url.pathname).toBe('/apps/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('state')).toHaveLength(43);
  });

  it('rejects arbitrary API and redirect origins', () => {
    expect(
      () =>
        new OfficialLeaderIdClient({
          baseUrl: 'http://127.0.0.1:9999/' as LeaderIdAppsBaseUrl,
          fetch: vi.fn() as unknown as typeof fetch,
        }),
    ).toThrow(/allowlist/u);

    const client = new OfficialLeaderIdClient({ fetch: vi.fn() as unknown as typeof fetch });
    expect(() =>
      client.createAuthorizationUrl({
        clientId: 'client-id',
        redirectUri: 'http://internal.example/callback',
        state: Buffer.alloc(32, 4).toString('base64url'),
      }),
    ).toThrow(/HTTPS/u);
  });

  it('exchanges credentials in the request body and never puts them in the URL', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(requestUrl(input));
      expect(url.toString()).toBe(`${LEADER_ID_APPS_PRODUCTION_BASE_URL}oauth/token`);
      expect(url.search).toBe('');
      expect(requestBody(init?.body)).toEqual({
        grant_type: 'client_credentials',
        client_id: 'client-id',
        client_secret: 'server-secret',
      });
      return jsonResponse({ access_token: 'application-token', expires_in: 120 });
    });
    const client = new OfficialLeaderIdClient({
      fetch: fetchMock as unknown as typeof fetch,
      now: () => new Date('2026-08-28T05:00:00.000Z'),
    });

    await expect(
      client.exchangeClientCredentials({
        clientId: 'client-id',
        clientSecret: 'server-secret',
      }),
    ).resolves.toEqual({
      accessToken: 'application-token',
      expiresAt: '2026-08-28T05:02:00.000Z',
    });
  });

  it('sends only the authorization-code fields documented by Apps v1', async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(requestBody(init?.body)).toEqual({
        grant_type: 'authorization_code',
        client_id: 'client-id',
        client_secret: 'server-secret',
        code: 'single-use-code',
      });
      return jsonResponse({ access_token: 'user-token', user_id: 77 });
    });
    const client = new OfficialLeaderIdClient({ fetch: fetchMock as unknown as typeof fetch });

    await expect(
      client.exchangeAuthorizationCode({
        clientId: 'client-id',
        clientSecret: 'server-secret',
        code: 'single-use-code',
      }),
    ).resolves.toMatchObject({ accessToken: 'user-token', leaderIdUserId: 77 });
  });

  it.each([
    ['live top-level response', { id: 77, status: 8 }],
    ['documented wrapped response', { data: { id: 77, status: 8 } }],
  ])('normalizes the %s for user lookup', async (_label, responseBody) => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(requestUrl(input)).toBe(`${LEADER_ID_APPS_PRODUCTION_BASE_URL}users/77`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer application-token');
      return jsonResponse(responseBody);
    });
    const client = new OfficialLeaderIdClient({ fetch: fetchMock as unknown as typeof fetch });

    await expect(client.getUser(77, 'application-token')).resolves.toEqual({ id: 77, status: 8 });
  });

  it('uses a bearer token and normalizes official participation data', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer user-token');
      expect(requestUrl(input)).toContain('/users/77/event-participations');
      if (init?.method === 'POST') {
        expect(requestBody(init.body)).toEqual({
          eventId: 606466,
          disableNotifications: false,
        });
        return jsonResponse({
          id: 'participation-id',
          event: { id: 606466 },
          moderation: 'approved',
          completed: false,
          createdAt: '2026-08-28 05:00:00',
        });
      }
      return jsonResponse({
        items: [
          {
            id: 'participation-id',
            event: { id: 606466 },
            moderation: 'wait',
            completed: false,
          },
        ],
        meta: { paginationPageCount: 1, paginationPage: 1, paginationSize: 100 },
      });
    });
    const client = new OfficialLeaderIdClient({ fetch: fetchMock as unknown as typeof fetch });

    await expect(client.listParticipations(77, 'user-token')).resolves.toEqual([
      {
        id: 'participation-id',
        eventId: 606466,
        moderation: 'wait',
        completed: false,
      },
    ]);
    await expect(
      client.createParticipation({
        userId: 77,
        eventId: 606466,
        accessToken: 'user-token',
        disableNotifications: false,
      }),
    ).resolves.toMatchObject({
      eventId: 606466,
      moderation: 'approved',
    });
  });

  it('sends the documented minimal participation body when optional fields are omitted', async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(requestBody(init?.body)).toEqual({ eventId: 606466 });
      return jsonResponse({
        id: 'participation-id',
        event: { id: 606466 },
        moderation: 'approved',
        completed: false,
      });
    });
    const client = new OfficialLeaderIdClient({ fetch: fetchMock as unknown as typeof fetch });

    await expect(
      client.createParticipation({
        userId: 77,
        eventId: 606466,
        accessToken: 'user-token',
      }),
    ).resolves.toMatchObject({ eventId: 606466, moderation: 'approved' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('trusts documented page-count metadata even when an intermediate page is short', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const page = new URL(requestUrl(input)).searchParams.get('paginationPage');
      return jsonResponse({
        items: [
          {
            id: `participation-${page}`,
            event: { id: 606_465 + Number(page) },
            moderation: 'approved',
            completed: false,
          },
        ],
        meta: { paginationPageCount: 2, paginationPage: Number(page), paginationSize: 100 },
      });
    });
    const client = new OfficialLeaderIdClient({ fetch: fetchMock as unknown as typeof fetch });

    await expect(client.listParticipations(77, 'user-token')).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns a sanitized retryable error and honors Retry-After', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ name: 'RateLimitExceeded', message: 'secret upstream diagnostic' }, 429, {
        'retry-after': '2',
      }),
    );
    const client = new OfficialLeaderIdClient({ fetch: fetchMock as unknown as typeof fetch });

    const error = await client.getUser(77, 'user-token').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LeaderIdApiError);
    expect(error).toMatchObject({
      status: 429,
      retryable: true,
      retryAfterMs: 2_000,
      externalCode: 'RateLimitExceeded',
    });
    expect((error as Error).message).not.toContain('secret upstream diagnostic');
  });

  it('rejects oversized external responses before parsing them', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('x'.repeat(2_000), {
          status: 200,
          headers: { 'content-length': '2000' },
        }),
    );
    const client = new OfficialLeaderIdClient({
      fetch: fetchMock as unknown as typeof fetch,
      maximumResponseBytes: 1_024,
    });
    await expect(client.getUser(77, 'token')).rejects.toMatchObject({
      externalCode: 'RESPONSE_TOO_LARGE',
    });
  });
});
