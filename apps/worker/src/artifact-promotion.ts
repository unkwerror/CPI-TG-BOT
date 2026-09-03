import { withCopySuffix } from '@cpi/shared';

export interface PromotionObjectHead {
  contentLength: number | undefined;
  metadata: Record<string, string> | undefined;
}

export interface ArtifactPromotionInput {
  desiredKey: string;
  artifactId: string;
  submissionId: string;
  sizeBytes: number;
  checksumSha256: string;
}

export interface ArtifactPromotionResult<CommitResult> {
  targetKey: string;
  commitResult: CommitResult;
}

export interface ArtifactPromotionDependencies<Transaction, CommitResult> {
  withLockedTransaction: (
    desiredKey: string,
    operation: (transaction: Transaction) => Promise<ArtifactPromotionResult<CommitResult>>,
  ) => Promise<ArtifactPromotionResult<CommitResult>>;
  lockCandidate: (transaction: Transaction, candidate: string) => Promise<void>;
  findOwner: (transaction: Transaction, candidate: string) => Promise<string | undefined>;
  headDestination: (candidate: string) => Promise<PromotionObjectHead | undefined>;
  copyDestination: (candidate: string) => Promise<void>;
  commit: (transaction: Transaction, candidate: string) => Promise<CommitResult>;
}

function assertDestinationMatches(
  head: PromotionObjectHead,
  input: ArtifactPromotionInput,
  targetKey: string,
): void {
  const metadata = head.metadata;
  if (
    head.contentLength !== input.sizeBytes ||
    metadata?.artifact !== input.artifactId ||
    metadata.submission !== input.submissionId ||
    metadata.sha256 !== input.checksumSha256
  ) {
    throw new Error(`Promoted S3 object verification failed for ${targetKey}`);
  }
}

export async function promoteArtifactObject<Transaction, CommitResult>(
  input: ArtifactPromotionInput,
  dependencies: ArtifactPromotionDependencies<Transaction, CommitResult>,
): Promise<ArtifactPromotionResult<CommitResult>> {
  return dependencies.withLockedTransaction(input.desiredKey, async (transaction) => {
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const candidate = withCopySuffix(input.desiredKey, attempt);
      // The base-name lock serializes the usual collision. Locking every suffix also closes the
      // less obvious race with a real filename that already contains the same "(N)" suffix.
      await dependencies.lockCandidate(transaction, candidate);
      const ownerId = await dependencies.findOwner(transaction, candidate);
      if (ownerId && ownerId !== input.artifactId) continue;

      const existing = await dependencies.headDestination(candidate);
      if (existing && existing.metadata?.artifact !== input.artifactId) {
        if (ownerId === input.artifactId) {
          throw new Error(`Database key ${candidate} points to another S3 object`);
        }
        continue;
      }

      if (!existing) await dependencies.copyDestination(candidate);
      const copied = existing ?? (await dependencies.headDestination(candidate));
      if (!copied) throw new Error(`Promoted S3 object ${candidate} was not found after copy`);
      assertDestinationMatches(copied, input, candidate);

      const commitResult = await dependencies.commit(transaction, candidate);
      return { targetKey: candidate, commitResult };
    }
    throw new Error(`No free object key for ${input.desiredKey} after 50 attempts`);
  });
}
