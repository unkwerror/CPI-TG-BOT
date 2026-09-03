import { describe, expect, it } from 'vitest';
import { evaluateFilePolicy } from '@cpi/shared';
import { configuredClamavScanner, mustQuarantineBeforeScan } from './verification-policy';

describe('artifact scanner policy', () => {
  it('keeps executable formats quarantined unless a scanner endpoint is configured', () => {
    const executable = evaluateFilePolicy({
      fileName: 'script.sh',
      mimeType: 'text/x-shellscript',
      sizeBytes: 10,
      maxFileSizeBytes: 100,
    });
    expect(executable).toMatchObject({ allowed: true, requiresQuarantine: true });
    if (!executable.allowed) throw new Error('Executable policy unexpectedly rejected the file');

    const missingScanner = configuredClamavScanner({
      FILE_VERIFICATION_MODE: 'metadata-only',
      CLAMAV_PORT: 3310,
    });
    expect(mustQuarantineBeforeScan(executable.requiresQuarantine, missingScanner)).toBe(true);

    const configuredScanner = configuredClamavScanner({
      FILE_VERIFICATION_MODE: 'clamav',
      CLAMAV_HOST: ' clamav ',
      CLAMAV_PORT: 3310,
    });
    expect(configuredScanner).toEqual({ host: 'clamav', port: 3310 });
    expect(mustQuarantineBeforeScan(executable.requiresQuarantine, configuredScanner)).toBe(false);
  });
});
