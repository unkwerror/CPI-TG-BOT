import { describe, expect, it } from 'vitest';
import { fileSignatureMatches, inspectFileSignature } from './file-signature';

describe('artifact magic-byte verification', () => {
  it('accepts a declared PNG when its signature is PNG', async () => {
    const pngHeader = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52,
    ]);
    await expect(inspectFileSignature(pngHeader, 'image/png', 'png')).resolves.toMatchObject({
      detected: { mime: 'image/png', ext: 'png' },
      matches: true,
    });
  });

  it('rejects a binary signature disguised as another MIME type', () => {
    expect(
      fileSignatureMatches('image/png', 'png', {
        mime: 'application/x-msdownload',
        ext: 'exe',
      }),
    ).toBe(false);
  });

  it('allows ZIP container detection for an OOXML document', () => {
    expect(
      fileSignatureMatches(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'docx',
        { mime: 'application/zip', ext: 'zip' },
      ),
    ).toBe(true);
  });
});
