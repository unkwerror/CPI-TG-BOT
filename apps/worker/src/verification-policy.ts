import type { WorkerEnvironment } from '@cpi/config';

export interface ClamavScannerEndpoint {
  host: string;
  port: number;
}

type VerificationConfiguration = Pick<
  WorkerEnvironment,
  'FILE_VERIFICATION_MODE' | 'CLAMAV_HOST' | 'CLAMAV_PORT'
>;

export function configuredClamavScanner(
  configuration: VerificationConfiguration,
): ClamavScannerEndpoint | undefined {
  if (configuration.FILE_VERIFICATION_MODE !== 'clamav') return undefined;
  const host = configuration.CLAMAV_HOST?.trim();
  return host ? { host, port: configuration.CLAMAV_PORT } : undefined;
}

export function mustQuarantineBeforeScan(
  requiresQuarantine: boolean,
  scanner: ClamavScannerEndpoint | undefined,
): boolean {
  return requiresQuarantine && !scanner;
}
