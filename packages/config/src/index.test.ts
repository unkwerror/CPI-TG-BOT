import { describe, expect, it } from 'vitest';
import { apiEnvironmentSchema, workerEnvironmentSchema } from './index';

const requiredApiEnvironment = {
  DATABASE_URL: 'postgresql://api:secret@localhost:5432/artifacts',
  WEB_ORIGIN: 'https://artifacts.example.test',
  TELEGRAM_BOT_TOKEN: 'telegram-token',
  CRM_API_URL: 'https://crm.example.test/api',
  CRM_INTEGRATION_TOKEN: 'x'.repeat(32),
  S3_ACCESS_KEY: 'access-key',
  S3_SECRET_KEY: 'secret-key',
};

const requiredWorkerEnvironment = {
  DATABASE_URL: 'postgresql://worker:secret@localhost:5432/artifacts',
  WEB_ORIGIN: 'https://artifacts.example.test',
  CRM_API_URL: 'https://crm.example.test/api',
  CRM_INTEGRATION_TOKEN: 'x'.repeat(32),
  S3_ACCESS_KEY: 'access-key',
  S3_SECRET_KEY: 'secret-key',
};

describe('worker environment', () => {
  it('allows metadata-only verification without a ClamAV endpoint', () => {
    expect(
      workerEnvironmentSchema.safeParse({
        ...requiredWorkerEnvironment,
        FILE_VERIFICATION_MODE: 'metadata-only',
      }).success,
    ).toBe(true);
  });

  it('rejects clamav verification without a non-empty host', () => {
    for (const CLAMAV_HOST of [undefined, '', '   ']) {
      const result = workerEnvironmentSchema.safeParse({
        ...requiredWorkerEnvironment,
        FILE_VERIFICATION_MODE: 'clamav',
        CLAMAV_HOST,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: ['CLAMAV_HOST'] })]),
        );
      }
    }
  });

  it('accepts clamav verification with its scanner endpoint', () => {
    expect(
      workerEnvironmentSchema.safeParse({
        ...requiredWorkerEnvironment,
        FILE_VERIFICATION_MODE: 'clamav',
        CLAMAV_HOST: 'clamav',
        CLAMAV_PORT: '3310',
      }),
    ).toMatchObject({
      success: true,
      data: { CLAMAV_HOST: 'clamav', CLAMAV_PORT: 3310 },
    });
  });

  it('normalizes a safe storage prefix and rejects empty/traversal prefixes', () => {
    expect(
      workerEnvironmentSchema.parse({
        ...requiredWorkerEnvironment,
        S3_PREFIX: ' /locker/ ',
      }).S3_PREFIX,
    ).toBe('locker/');
    for (const S3_PREFIX of ['/', '../locker', 'locker/../crm', 'locker//crm']) {
      expect(
        workerEnvironmentSchema.safeParse({ ...requiredWorkerEnvironment, S3_PREFIX }).success,
      ).toBe(false);
    }
  });

  it('requires the isolated locker prefix in production', () => {
    expect(
      workerEnvironmentSchema.safeParse({
        ...requiredWorkerEnvironment,
        NODE_ENV: 'production',
        S3_PREFIX: 'crm/',
      }).success,
    ).toBe(false);
  });
});

describe('Leader-ID API environment', () => {
  it('keeps the integration disabled without loading partner secrets', () => {
    expect(apiEnvironmentSchema.parse(requiredApiEnvironment)).toMatchObject({
      LEADER_ID_ENABLED: false,
      LEADER_ID_ENVIRONMENT: 'production',
      LEADER_ID_OAUTH_STATE_TTL_SECONDS: 600,
      LEADER_ID_API_TIMEOUT_MS: 10_000,
    });
  });

  it('rejects the undocumented mixed Leader-ID staging OAuth/API environment', () => {
    expect(
      apiEnvironmentSchema.safeParse({
        ...requiredApiEnvironment,
        LEADER_ID_ENVIRONMENT: 'staging',
      }).success,
    ).toBe(false);
  });

  it('requires a complete canonical encryption key ring when enabled', () => {
    const missing = apiEnvironmentSchema.safeParse({
      ...requiredApiEnvironment,
      LEADER_ID_ENABLED: 'true',
    });
    expect(missing.success).toBe(false);

    const key = Buffer.alloc(32, 7).toString('base64url');
    expect(
      apiEnvironmentSchema.safeParse({
        ...requiredApiEnvironment,
        LEADER_ID_ENABLED: 'true',
        LEADER_ID_CLIENT_ID: 'catalyst',
        LEADER_ID_CLIENT_SECRET: 'leader-id-secret',
        LEADER_ID_SERVER_CLIENT_ID: 'catalyst-server',
        LEADER_ID_SERVER_CLIENT_SECRET: 'leader-id-server-secret',
        LEADER_ID_TOKEN_ACTIVE_KEY_ID: 'v1',
        LEADER_ID_TOKEN_KEYRING: JSON.stringify({ v1: key }),
      }),
    ).toMatchObject({
      success: true,
      data: { LEADER_ID_ENABLED: true, LEADER_ID_TOKEN_ACTIVE_KEY_ID: 'v1' },
    });
  });

  it('rejects malformed, non-canonical and incomplete Leader-ID key rings', () => {
    for (const LEADER_ID_TOKEN_KEYRING of [
      '{}',
      '{',
      JSON.stringify({ v1: 'short' }),
      JSON.stringify({ other: Buffer.alloc(32, 9).toString('base64url') }),
    ]) {
      const result = apiEnvironmentSchema.safeParse({
        ...requiredApiEnvironment,
        LEADER_ID_ENABLED: 'true',
        LEADER_ID_CLIENT_ID: 'catalyst',
        LEADER_ID_CLIENT_SECRET: 'leader-id-secret',
        LEADER_ID_SERVER_CLIENT_ID: 'catalyst-server',
        LEADER_ID_SERVER_CLIENT_SECRET: 'leader-id-server-secret',
        LEADER_ID_TOKEN_ACTIVE_KEY_ID: 'v1',
        LEADER_ID_TOKEN_KEYRING,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: ['LEADER_ID_TOKEN_KEYRING'] })]),
        );
      }
    }
  });
});
