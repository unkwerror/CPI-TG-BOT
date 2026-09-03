import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@cpi/shared';
import type {
  LeaderIdOAuthStateManager,
  LeaderIdOAuthStateRecord,
  LeaderIdOAuthStateRepository,
  LeaderIdTokenCipher,
  LeaderIdTokenSet,
} from './leader-id-contract';

const OAUTH_STATE_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const ENVELOPE_VERSION = 'lid1';
const TOKEN_AAD_PREFIX = 'catalyst:leader-id:tokens:';

const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);
const keyIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/u);

const tokenSetSchema = z
  .object({
    accessToken: z.string().min(1).max(32_768),
    refreshToken: z.string().min(1).max(32_768).optional(),
    leaderIdUserId: z.number().int().positive().safe().optional(),
    userValidated: z.boolean().optional(),
    expiresAt: z.iso.datetime().optional(),
  })
  .strict();

const oauthStateRecordSchema = z
  .object({
    catalystUserId: z.string().min(1).max(128),
    expectedLeaderIdUserId: z.number().int().positive().safe(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

function decodeBase64Url(value: string, label: string): Buffer {
  base64UrlSchema.parse(value);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new Error(`${label} is not canonical base64url`);
  }
  return decoded;
}

function tokenAad(catalystUserId: string): Buffer {
  if (!catalystUserId || catalystUserId.length > 128) {
    throw new Error('Catalyst user ID is invalid');
  }
  return Buffer.from(`${TOKEN_AAD_PREFIX}${catalystUserId}`, 'utf8');
}

export interface LeaderIdTokenKeyRing {
  activeKeyId: string;
  keys: Readonly<Record<string, string | Buffer>>;
}

/** AES-256-GCM envelope encryption with key IDs so secrets can be rotated without token loss. */
export class AesGcmLeaderIdTokenCipher implements LeaderIdTokenCipher {
  readonly #activeKeyId: string;
  readonly #keys = new Map<string, Buffer>();

  constructor(keyRing: LeaderIdTokenKeyRing) {
    this.#activeKeyId = keyIdSchema.parse(keyRing.activeKeyId);
    for (const [keyIdValue, encodedOrBuffer] of Object.entries(keyRing.keys)) {
      const keyId = keyIdSchema.parse(keyIdValue);
      const key = Buffer.isBuffer(encodedOrBuffer)
        ? Buffer.from(encodedOrBuffer)
        : decodeBase64Url(encodedOrBuffer, `Leader-ID encryption key ${keyId}`);
      if (key.length !== 32) {
        throw new Error(`Leader-ID encryption key ${keyId} must contain exactly 32 bytes`);
      }
      this.#keys.set(keyId, key);
    }
    if (!this.#keys.has(this.#activeKeyId)) {
      throw new Error('Active Leader-ID encryption key is missing from the key ring');
    }
  }

  encrypt(tokens: LeaderIdTokenSet, catalystUserId: string): string {
    const normalized = tokenSetSchema.parse(tokens);
    const key = this.#keys.get(this.#activeKeyId);
    if (!key) throw new Error('Active Leader-ID encryption key is unavailable');

    const nonce = randomBytes(GCM_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: GCM_TAG_BYTES });
    cipher.setAAD(tokenAad(catalystUserId));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(normalized), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      ENVELOPE_VERSION,
      this.#activeKeyId,
      nonce.toString('base64url'),
      ciphertext.toString('base64url'),
      tag.toString('base64url'),
    ].join('.');
  }

  decrypt(envelope: string, catalystUserId: string): LeaderIdTokenSet {
    if (envelope.length > 100_000) throw new Error('Leader-ID token envelope is too large');
    const parts = envelope.split('.');
    if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION) {
      throw new Error('Leader-ID token envelope has an unsupported format');
    }
    const keyId = keyIdSchema.parse(parts[1]);
    const key = this.#keys.get(keyId);
    if (!key) throw new Error('Leader-ID token envelope uses an unavailable key');
    const nonce = decodeBase64Url(parts[2] ?? '', 'Leader-ID token nonce');
    const ciphertext = decodeBase64Url(parts[3] ?? '', 'Leader-ID token ciphertext');
    const tag = decodeBase64Url(parts[4] ?? '', 'Leader-ID token tag');
    if (nonce.length !== GCM_NONCE_BYTES || tag.length !== GCM_TAG_BYTES) {
      throw new Error('Leader-ID token envelope has invalid cryptographic parameters');
    }

    const decipher = createDecipheriv('aes-256-gcm', key, nonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(tokenAad(catalystUserId));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length > 65_536) throw new Error('Leader-ID token payload is too large');
    const parsed = tokenSetSchema.parse(JSON.parse(plaintext.toString('utf8')));
    return {
      accessToken: parsed.accessToken,
      ...(parsed.refreshToken === undefined ? {} : { refreshToken: parsed.refreshToken }),
      ...(parsed.leaderIdUserId === undefined ? {} : { leaderIdUserId: parsed.leaderIdUserId }),
      ...(parsed.userValidated === undefined ? {} : { userValidated: parsed.userValidated }),
      ...(parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt }),
    };
  }
}

function stateDigest(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('base64url');
}

export interface SecureLeaderIdOAuthStateManagerOptions {
  repository: LeaderIdOAuthStateRepository;
  ttlSeconds?: number;
  now?: () => Date;
  random?: (size: number) => Buffer;
}

export class SecureLeaderIdOAuthStateManager implements LeaderIdOAuthStateManager {
  readonly #repository: LeaderIdOAuthStateRepository;
  readonly #ttlSeconds: number;
  readonly #now: () => Date;
  readonly #random: (size: number) => Buffer;

  constructor(options: SecureLeaderIdOAuthStateManagerOptions) {
    this.#repository = options.repository;
    this.#ttlSeconds = options.ttlSeconds ?? 600;
    if (!Number.isInteger(this.#ttlSeconds) || this.#ttlSeconds < 60 || this.#ttlSeconds > 1_800) {
      throw new Error('Leader-ID OAuth state TTL must be between 60 and 1800 seconds');
    }
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? randomBytes;
  }

  async issue(input: { catalystUserId: string; expectedLeaderIdUserId: number }): Promise<string> {
    if (!input.catalystUserId || input.catalystUserId.length > 128) {
      throw new Error('Catalyst user ID is invalid');
    }
    if (!Number.isSafeInteger(input.expectedLeaderIdUserId) || input.expectedLeaderIdUserId <= 0) {
      throw new Error('Expected Leader-ID user ID is invalid');
    }
    const stateBytes = this.#random(OAUTH_STATE_BYTES);
    if (stateBytes.length !== OAUTH_STATE_BYTES) {
      throw new Error('OAuth state generator returned an invalid byte count');
    }
    const state = stateBytes.toString('base64url');
    const now = this.#now();
    const record: LeaderIdOAuthStateRecord = {
      catalystUserId: input.catalystUserId,
      expectedLeaderIdUserId: input.expectedLeaderIdUserId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#ttlSeconds * 1_000).toISOString(),
    };
    await this.#repository.put(stateDigest(state), record, this.#ttlSeconds);
    return state;
  }

  async consume(state: string): Promise<LeaderIdOAuthStateRecord> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(state)) {
      throw new AppError('LEADER_ID_OAUTH_STATE_INVALID', 'Авторизация Leader-ID устарела', 400);
    }
    const raw = await this.#repository.take(stateDigest(state));
    if (!raw) {
      throw new AppError('LEADER_ID_OAUTH_STATE_INVALID', 'Авторизация Leader-ID устарела', 400);
    }
    const record = oauthStateRecordSchema.parse(raw);
    if (Date.parse(record.expiresAt) <= this.#now().getTime()) {
      throw new AppError('LEADER_ID_OAUTH_STATE_EXPIRED', 'Авторизация Leader-ID устарела', 400);
    }
    return record;
  }
}
