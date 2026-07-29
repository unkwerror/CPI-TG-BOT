import type { S3Client } from '@aws-sdk/client-s3';
import type { WorkerEnvironment } from '@cpi/config';
import type { Database } from '@cpi/db';
import type { Logger } from 'pino';

export interface WorkerContext {
  config: WorkerEnvironment;
  db: Database;
  s3: S3Client;
  logger: Logger;
}
