import { z } from 'zod';
import type {
  CreateLeaderIdParticipationInput,
  LeaderIdApiClient,
  LeaderIdParticipation,
  LeaderIdTokenSet,
  LeaderIdUser,
} from './leader-id-contract';

export const LEADER_ID_APPS_PRODUCTION_BASE_URL = 'https://apps.leader-id.ru/api/v1/' as const;
export const LEADER_ID_APPS_STAGING_BASE_URL = 'https://apps.leader-id.dev/api/v1/' as const;
export const LEADER_ID_AUTHORIZATION_URL = 'https://leader-id.ru/apps/authorize' as const;

export type LeaderIdAppsBaseUrl =
  typeof LEADER_ID_APPS_PRODUCTION_BASE_URL | typeof LEADER_ID_APPS_STAGING_BASE_URL;

const allowedApiBaseUrls = new Set<string>([
  LEADER_ID_APPS_PRODUCTION_BASE_URL,
  LEADER_ID_APPS_STAGING_BASE_URL,
]);

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(32_768),
    refresh_token: z.string().min(1).max(32_768).optional(),
    user_id: z.number().int().positive().safe().optional(),
    user_validated: z.boolean().optional(),
    expires_in: z.number().int().positive().max(31_536_000).optional(),
  })
  .passthrough();

const leaderIdUserSchema = z
  .object({
    id: z.number().int().positive().safe(),
    status: z.number().int().optional(),
  })
  .passthrough();

// The live Apps v1 endpoint currently returns the user object at the top level, while an older
// published schema and some installations wrap the same object in `data`. Accept both official
// shapes, but normalize immediately so the rest of the application has one strict contract.
const userResponseSchema = z.union([
  leaderIdUserSchema,
  z
    .object({ data: leaderIdUserSchema })
    .passthrough()
    .transform((payload) => payload.data),
]);

const participationSchema = z
  .object({
    id: z.string().min(1).max(256),
    event: z.object({ id: z.number().int().positive().safe() }).passthrough(),
    moderation: z.enum(['wait', 'approved', 'declined']),
    completed: z.boolean().default(false),
    completedAt: z.string().max(64).optional().nullable(),
    createdAt: z.string().max(64).optional(),
  })
  .passthrough();

const participationListSchema = z
  .object({
    items: z.array(participationSchema),
    meta: z
      .object({
        paginationPageCount: z.number().int().nonnegative().optional(),
        paginationPage: z.number().int().positive().optional(),
        paginationSize: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const safeExternalCodeSchema = z
  .union([z.string(), z.number()])
  .transform(String)
  .refine((value) => /^[A-Za-z0-9_.-]{1,80}$/u.test(value))
  .optional();

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function validatePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function validateOAuthClient(clientId: string, clientSecret: string): void {
  if (!clientId || clientId.length > 256) throw new Error('Leader-ID client ID is invalid');
  if (!clientSecret || clientSecret.length > 32_768) {
    throw new Error('Leader-ID client secret is invalid');
  }
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1_000), 60_000);
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - now, 0), 60_000);
  return undefined;
}

export class LeaderIdApiError extends Error {
  readonly status: number | null;
  readonly externalCode?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: {
    message: string;
    status: number | null;
    retryable: boolean;
    externalCode?: string;
    retryAfterMs?: number;
  }) {
    super(input.message);
    this.name = 'LeaderIdApiError';
    this.status = input.status;
    this.retryable = input.retryable;
    if (input.externalCode !== undefined) this.externalCode = input.externalCode;
    if (input.retryAfterMs !== undefined) this.retryAfterMs = input.retryAfterMs;
  }
}

export function isLeaderIdApiError(value: unknown): value is LeaderIdApiError {
  return value instanceof LeaderIdApiError;
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new LeaderIdApiError({
      message: 'Leader-ID вернул слишком большой ответ',
      status: response.status,
      retryable: false,
      externalCode: 'RESPONSE_TOO_LARGE',
    });
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new LeaderIdApiError({
          message: 'Leader-ID вернул слишком большой ответ',
          status: response.status,
          retryable: false,
          externalCode: 'RESPONSE_TOO_LARGE',
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(combined);
}

function sanitizedExternalCode(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate =
    'code' in payload
      ? (payload as { code?: unknown }).code
      : 'name' in payload
        ? (payload as { name?: unknown }).name
        : 'error' in payload
          ? (payload as { error?: unknown }).error
          : undefined;
  const parsed = safeExternalCodeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function toTokenSet(payload: z.infer<typeof tokenResponseSchema>, now: Date): LeaderIdTokenSet {
  return {
    accessToken: payload.access_token,
    ...(payload.refresh_token === undefined ? {} : { refreshToken: payload.refresh_token }),
    ...(payload.user_id === undefined ? {} : { leaderIdUserId: payload.user_id }),
    ...(payload.user_validated === undefined ? {} : { userValidated: payload.user_validated }),
    ...(payload.expires_in === undefined
      ? {}
      : { expiresAt: new Date(now.getTime() + payload.expires_in * 1_000).toISOString() }),
  };
}

function toParticipation(payload: z.infer<typeof participationSchema>): LeaderIdParticipation {
  return {
    id: payload.id,
    eventId: payload.event.id,
    moderation: payload.moderation,
    completed: payload.completed,
    ...(payload.createdAt === undefined ? {} : { createdAt: payload.createdAt }),
    ...(payload.completedAt == null ? {} : { completedAt: payload.completedAt }),
  };
}

function validateRedirectUri(value: string): string {
  const url = new URL(value);
  const localHttp =
    url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error('Leader-ID OAuth redirect URI must use HTTPS (except localhost)');
  }
  if (url.username || url.password || url.hash) {
    throw new Error('Leader-ID OAuth redirect URI contains unsupported URL components');
  }
  return url.toString();
}

export interface OfficialLeaderIdClientOptions {
  baseUrl?: LeaderIdAppsBaseUrl;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maximumResponseBytes?: number;
  now?: () => Date;
}

/** Client for the official Apps API v1 contract; callers cannot redirect it to arbitrary hosts. */
export class OfficialLeaderIdClient implements LeaderIdApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maximumResponseBytes: number;
  readonly #now: () => Date;

  constructor(options: OfficialLeaderIdClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? LEADER_ID_APPS_PRODUCTION_BASE_URL;
    if (!allowedApiBaseUrls.has(this.#baseUrl)) {
      throw new Error('Leader-ID API base URL is not in the official allowlist');
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 250 || this.#timeoutMs > 30_000) {
      throw new Error('Leader-ID API timeout must be between 250 and 30000 ms');
    }
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 1_048_576;
    if (
      !Number.isInteger(this.#maximumResponseBytes) ||
      this.#maximumResponseBytes < 1_024 ||
      this.#maximumResponseBytes > 4_194_304
    ) {
      throw new Error('Leader-ID maximum response size is outside the supported range');
    }
    this.#now = options.now ?? (() => new Date());
  }

  createAuthorizationUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    scope?: string;
  }): string {
    if (!input.clientId || input.clientId.length > 256)
      throw new Error('Leader-ID client ID is invalid');
    if (!/^[A-Za-z0-9_-]{43}$/u.test(input.state)) throw new Error('OAuth state is invalid');
    const url = new URL(LEADER_ID_AUTHORIZATION_URL);
    url.searchParams.set('client_id', input.clientId);
    url.searchParams.set('redirect_uri', validateRedirectUri(input.redirectUri));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', input.state);
    if (input.scope !== undefined) {
      if (!/^[A-Za-z0-9_.: -]{1,256}$/u.test(input.scope))
        throw new Error('OAuth scope is invalid');
      url.searchParams.set('scope', input.scope);
    }
    return url.toString();
  }

  async exchangeAuthorizationCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
  }): Promise<LeaderIdTokenSet> {
    validateOAuthClient(input.clientId, input.clientSecret);
    if (!input.code || input.code.length > 4_096) {
      throw new Error('Leader-ID authorization code is invalid');
    }
    return this.#requestToken({
      grant_type: 'authorization_code',
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
    });
  }

  async exchangeClientCredentials(input: {
    clientId: string;
    clientSecret: string;
  }): Promise<LeaderIdTokenSet> {
    validateOAuthClient(input.clientId, input.clientSecret);
    return this.#requestToken({
      grant_type: 'client_credentials',
      client_id: input.clientId,
      client_secret: input.clientSecret,
    });
  }

  async refreshAccessToken(input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<LeaderIdTokenSet> {
    validateOAuthClient(input.clientId, input.clientSecret);
    if (!input.refreshToken || input.refreshToken.length > 32_768) {
      throw new Error('Leader-ID refresh token is invalid');
    }
    return this.#requestToken({
      grant_type: 'refresh_token',
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
    });
  }

  async getUser(userId: number, accessToken: string): Promise<LeaderIdUser> {
    validatePositiveSafeInteger(userId, 'Leader-ID user ID');
    const raw = await this.#requestJson(`users/${encodeURIComponent(String(userId))}`, {
      method: 'GET',
      accessToken,
    });
    const parsed = userResponseSchema.parse(raw);
    return {
      id: parsed.id,
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
    };
  }

  async listParticipations(userId: number, accessToken: string): Promise<LeaderIdParticipation[]> {
    validatePositiveSafeInteger(userId, 'Leader-ID user ID');
    const results: LeaderIdParticipation[] = [];
    const pageSize = 100;
    for (let page = 1; page <= 100; page += 1) {
      const search = new URLSearchParams({
        paginationPage: String(page),
        paginationSize: String(pageSize),
      });
      const raw = await this.#requestJson(
        `users/${encodeURIComponent(String(userId))}/event-participations?${search.toString()}`,
        { method: 'GET', accessToken },
      );
      const parsed = participationListSchema.parse(raw);
      results.push(...parsed.items.map(toParticipation));
      const pageCount = parsed.meta?.paginationPageCount;
      if (
        (pageCount !== undefined && page >= pageCount) ||
        (pageCount === undefined && parsed.items.length < pageSize)
      ) {
        break;
      }
      if (page === 100) {
        throw new LeaderIdApiError({
          message: 'Leader-ID вернул слишком много страниц участий',
          status: 200,
          retryable: false,
          externalCode: 'PAGINATION_LIMIT',
        });
      }
    }
    return results;
  }

  async createParticipation(
    input: CreateLeaderIdParticipationInput,
  ): Promise<LeaderIdParticipation> {
    validatePositiveSafeInteger(input.userId, 'Leader-ID user ID');
    validatePositiveSafeInteger(input.eventId, 'Leader-ID event ID');
    if (
      input.quizAnswerId !== undefined &&
      (!input.quizAnswerId || input.quizAnswerId.length > 256)
    ) {
      throw new Error('Leader-ID questionnaire answer ID is invalid');
    }
    const body = {
      eventId: input.eventId,
      ...(input.disableNotifications === undefined
        ? {}
        : { disableNotifications: input.disableNotifications }),
      ...(input.quizAnswerId === undefined ? {} : { quizAnswerId: input.quizAnswerId }),
    };
    const raw = await this.#requestJson(
      `users/${encodeURIComponent(String(input.userId))}/event-participations`,
      { method: 'POST', accessToken: input.accessToken, body },
    );
    return toParticipation(participationSchema.parse(raw));
  }

  async #requestToken(body: Record<string, string>): Promise<LeaderIdTokenSet> {
    const raw = await this.#requestJson('oauth/token', { method: 'POST', body });
    return toTokenSet(tokenResponseSchema.parse(raw), this.#now());
  }

  async #requestJson(
    path: string,
    input: {
      method: 'GET' | 'POST';
      accessToken?: string;
      body?: Record<string, unknown>;
    },
  ): Promise<unknown> {
    const url = new URL(path, this.#baseUrl);
    if (url.origin !== new URL(this.#baseUrl).origin || !url.pathname.startsWith('/api/v1/')) {
      throw new Error('Leader-ID request escaped the official API base path');
    }
    const headers = new Headers({ Accept: 'application/json' });
    if (input.accessToken !== undefined) {
      if (!input.accessToken || input.accessToken.length > 32_768) {
        throw new Error('Leader-ID access token is invalid');
      }
      headers.set('Authorization', `Bearer ${input.accessToken}`);
    }
    let body: string | undefined;
    if (input.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(input.body);
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: input.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (isLeaderIdApiError(error)) throw error;
      throw new LeaderIdApiError({
        message: 'Не удалось связаться с Leader-ID',
        status: null,
        retryable: true,
        externalCode:
          error instanceof DOMException && error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK',
      });
    }

    const text = await readBoundedText(response, this.#maximumResponseBytes);
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new LeaderIdApiError({
          message: 'Leader-ID вернул некорректный ответ',
          status: response.status,
          retryable: response.status >= 500,
          externalCode: 'INVALID_JSON',
        });
      }
    }
    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      const externalCode = sanitizedExternalCode(payload);
      throw new LeaderIdApiError({
        message: 'Leader-ID отклонил запрос',
        status: response.status,
        retryable: retryableStatus(response.status),
        ...(externalCode === undefined ? {} : { externalCode }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }
    return payload;
  }
}
