import { describe, expect, it } from 'vitest';
import {
  promoteArtifactObject,
  type ArtifactPromotionDependencies,
  type ArtifactPromotionInput,
  type PromotionObjectHead,
} from './artifact-promotion';

interface FakeTransaction {
  artifactId: string;
  releases: Array<() => void>;
}

function input(artifactId: string): ArtifactPromotionInput {
  return {
    desiredKey: 'locker/artifacts/Событие/Участник/report.pdf',
    artifactId,
    submissionId: `submission-${artifactId}`,
    sizeBytes: 8,
    checksumSha256: `sha-${artifactId}`,
  };
}

function createHarness() {
  const database = new Map<string, string>();
  const storage = new Map<string, PromotionObjectHead>();
  const lockTails = new Map<string, Promise<void>>();
  let copyCount = 0;

  const acquire = async (key: string): Promise<() => void> => {
    const previous = lockTails.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    lockTails.set(
      key,
      previous.then(() => current),
    );
    await previous;
    return release;
  };

  const dependencies = (
    promotion: ArtifactPromotionInput,
  ): ArtifactPromotionDependencies<FakeTransaction, true> => ({
    withLockedTransaction: async (desiredKey, operation) => {
      const release = await acquire(desiredKey);
      const transaction: FakeTransaction = { artifactId: promotion.artifactId, releases: [] };
      try {
        return await operation(transaction);
      } finally {
        for (const releaseCandidate of transaction.releases.reverse()) releaseCandidate();
        release();
      }
    },
    lockCandidate: async (transaction, candidate) => {
      if (candidate === promotion.desiredKey) return;
      transaction.releases.push(await acquire(candidate));
    },
    findOwner: async (_transaction, candidate) => database.get(candidate),
    headDestination: async (candidate) => storage.get(candidate),
    copyDestination: async (candidate) => {
      copyCount += 1;
      await Promise.resolve();
      storage.set(candidate, {
        contentLength: promotion.sizeBytes,
        metadata: {
          artifact: promotion.artifactId,
          submission: promotion.submissionId,
          sha256: promotion.checksumSha256,
        },
      });
    },
    commit: async (_transaction, candidate) => {
      if (database.has(candidate) && database.get(candidate) !== promotion.artifactId) {
        throw new Error('unique object key violation');
      }
      database.set(candidate, promotion.artifactId);
      return true;
    },
  });

  return {
    database,
    storage,
    dependencies,
    copyCount: () => copyCount,
  };
}

describe('artifact promotion saga', () => {
  it('serializes two concurrent artifacts with the same human filename', async () => {
    const harness = createHarness();
    const first = input('artifact-a');
    const second = input('artifact-b');

    const results = await Promise.all([
      promoteArtifactObject(first, harness.dependencies(first)),
      promoteArtifactObject(second, harness.dependencies(second)),
    ]);

    expect(new Set(results.map((result) => result.targetKey))).toEqual(
      new Set([first.desiredKey, 'locker/artifacts/Событие/Участник/report (2).pdf']),
    );
    expect(harness.database.size).toBe(2);
    expect(harness.storage.size).toBe(2);
    expect(harness.copyCount()).toBe(2);
  });

  it('reuses a verified destination left by a retry after copy', async () => {
    const harness = createHarness();
    const retry = input('artifact-retry');
    harness.storage.set(retry.desiredKey, {
      contentLength: retry.sizeBytes,
      metadata: {
        artifact: retry.artifactId,
        submission: retry.submissionId,
        sha256: retry.checksumSha256,
      },
    });

    const result = await promoteArtifactObject(retry, harness.dependencies(retry));

    expect(result.targetKey).toBe(retry.desiredKey);
    expect(harness.database.get(retry.desiredKey)).toBe(retry.artifactId);
    expect(harness.copyCount()).toBe(0);
  });

  it('reuses a key already claimed by the same artifact in the database', async () => {
    const harness = createHarness();
    const retry = input('artifact-claimed');
    harness.database.set(retry.desiredKey, retry.artifactId);
    harness.storage.set(retry.desiredKey, {
      contentLength: retry.sizeBytes,
      metadata: {
        artifact: retry.artifactId,
        submission: retry.submissionId,
        sha256: retry.checksumSha256,
      },
    });

    await expect(promoteArtifactObject(retry, harness.dependencies(retry))).resolves.toMatchObject({
      targetKey: retry.desiredKey,
      commitResult: true,
    });
    expect(harness.copyCount()).toBe(0);
  });

  it('refuses to commit a retry when strict destination metadata does not match', async () => {
    const harness = createHarness();
    const retry = input('artifact-corrupt');
    harness.storage.set(retry.desiredKey, {
      contentLength: retry.sizeBytes,
      metadata: {
        artifact: retry.artifactId,
        submission: retry.submissionId,
        sha256: 'another-checksum',
      },
    });

    await expect(promoteArtifactObject(retry, harness.dependencies(retry))).rejects.toThrow(
      /verification failed/,
    );
    expect(harness.database.has(retry.desiredKey)).toBe(false);
  });
});
