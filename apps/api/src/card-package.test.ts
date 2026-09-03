import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import {
  assertCardPackageHead,
  cardPackageBasePath,
  extractCardPackage,
  normalizeCardPackagePath,
  renderCardPackageDocument,
} from './card-package';

async function zipFixture(files: Record<string, string | Buffer>) {
  const zip = new ZipFile();
  for (const [path, value] of Object.entries(files)) {
    zip.addBuffer(Buffer.isBuffer(value) ? value : Buffer.from(value), path);
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const transparentPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('card package ZIP', () => {
  it('extracts a nested self-contained animated web package', async () => {
    const archive = await zipFixture({
      'catalyst/index.html': `<!doctype html><html><head><link rel="stylesheet" href="assets/card.css"></head><body><section class="card"><img src="assets/photo.png"><h1>CATALYST</h1></section><script src="assets/card.js"></script></body></html>`,
      'catalyst/assets/card.css':
        '.card{animation:float 2s infinite}@keyframes float{50%{transform:translateY(-8px)}}',
      'catalyst/assets/card.js': "document.querySelector('.card')?.classList.add('ready')",
      'catalyst/assets/photo.png': transparentPng,
    });
    const result = await extractCardPackage(archive);
    expect(result.entryPath).toBe('catalyst/index.html');
    expect(result.entryHtml).toContain('assets/card.css');
    expect(result.files.map((file) => file.path)).toEqual([
      'catalyst/index.html',
      'catalyst/assets/card.css',
      'catalyst/assets/card.js',
      'catalyst/assets/photo.png',
    ]);
    expect(result.totalUncompressedBytes).toBeGreaterThan(transparentPng.length);
  });

  it('uses a single HTML file when index.html is absent', async () => {
    const archive = await zipFixture({ 'card.html': '<h1>Без index</h1>' });
    const result = await extractCardPackage(archive);
    expect(result.entryPath).toBe('card.html');
    expect(result.entryHtml).toContain('Без index');
  });

  it('assembles a manifest module with separate HTML, CSS, JS and assets', async () => {
    const archive = await zipFixture({
      'catalyst-product-card/manifest.json': JSON.stringify({
        entry: 'component/catalyst-card.html',
        style: 'component/catalyst-card.css',
        script: 'component/catalyst-card.js',
        assets: { dark: 'assets/tee-dark-front.png' },
      }),
      'catalyst-product-card/component/catalyst-card.html':
        '<article data-catalyst-card><img src="../assets/tee-dark-front.png"><button data-catalyst-action="select">Выбрать</button></article>',
      'catalyst-product-card/component/catalyst-card.css':
        '[data-catalyst-card]{animation:float 2s infinite}@keyframes float{to{transform:translateY(-4px)}}',
      'catalyst-product-card/component/catalyst-card.js': 'window.CatalystProductCard={ready:true}',
      'catalyst-product-card/assets/tee-dark-front.png': transparentPng,
    });
    const result = await extractCardPackage(archive);
    expect(result.entryPath).toBe('catalyst-product-card/component/catalyst-card.html');
    expect(result.entryHtml).toContain('<link rel="stylesheet" href="catalyst-card.css">');
    expect(result.entryHtml).toContain('<script src="catalyst-card.js"></script>');
    expect(result.entryHtml).toContain('data-catalyst-action');
    expect(result.files.map((file) => file.path)).toContain(
      'catalyst-product-card/assets/tee-dark-front.png',
    );
  });

  it('rejects a package without an HTML entry', async () => {
    const archive = await zipFixture({ 'styles.css': 'body{color:white}' });
    await expect(extractCardPackage(archive)).rejects.toMatchObject({
      code: 'CARD_PACKAGE_ENTRY_MISSING',
    });
  });

  it('rejects traversal and absolute package paths', () => {
    expect(normalizeCardPackagePath('../secret.txt')).toBeNull();
    expect(normalizeCardPackagePath('/etc/passwd')).toBeNull();
    expect(normalizeCardPackagePath('C:/secret.txt')).toBeNull();
    expect(normalizeCardPackagePath('assets\\photo.png')).toBeNull();
    expect(normalizeCardPackagePath('./assets/photo.png')).toBe('assets/photo.png');
  });

  it('binds the uploaded S3 object to its target and byte size', () => {
    const input = {
      packageId: '10000000-0000-4000-8000-000000000001',
      entityType: 'product' as const,
      entityId: '20000000-0000-4000-8000-000000000002',
      sizeBytes: 1234,
    };
    expect(() =>
      assertCardPackageHead(input, {
        ContentLength: 1234,
        ContentType: 'application/zip',
        Metadata: {
          'package-id': `${input.packageId},${input.packageId}`,
          'entity-type': 'product,product',
          'entity-id': `${input.entityId},${input.entityId}`,
          'expected-size': '1234,1234',
        },
        $metadata: {},
      }),
    ).not.toThrow();
    expect(() =>
      assertCardPackageHead(input, {
        ContentLength: 1235,
        ContentType: 'application/zip',
        Metadata: {},
        $metadata: {},
      }),
    ).toThrowError(/не соответствует/u);
  });

  it('injects a package-local base path and the automatic height bridge', () => {
    const id = '10000000-0000-4000-8000-000000000001';
    expect(cardPackageBasePath(id, 'folder/index.html')).toBe(
      `/api/v1/card-packages/${id}/files/folder/`,
    );
    const document = renderCardPackageDocument(
      id,
      'folder/index.html',
      '<html><head><title>Card</title><link href="/assets/card.css"></head><body><img src="/assets/photo.png"><div>OK</div></body></html>',
      ['assets/card.css', 'assets/photo.png'],
    );
    expect(document).toContain(`<base href="/api/v1/card-packages/${id}/files/folder/">`);
    expect(document).toContain('cpi-card-height');
    expect(document).toContain('cpi-card-scroll');
    expect(document).toContain('addEventListener("wheel"');
    expect(document).toContain('addEventListener("touchmove"');
    expect(document).toContain('stopImmediatePropagation');
    expect(document).toContain('maxScroll');
    expect(document.indexOf('stopImmediatePropagation')).toBeLessThan(
      document.lastIndexOf('addEventListener("wheel"'),
    );
    expect(document).toContain('cpi-card-fields');
    expect(document).toContain('cpi-card-link');
    expect(document).toContain('data-cpi-field');
    expect(document).toContain('meta charset="utf-8"');
    expect(document).toContain('setAttribute("data-cpi-fields"');
    expect(document).toContain('data-cpi-display="fullscreen"');
    expect(document).toContain('overscroll-behavior-y:contain');
    expect(document).toContain('touch-action:pan-y pinch-zoom');
    expect(document).toContain('typeof ResizeObserver==="function"');
    expect(document).toContain('window.queueMicrotask?');
    expect(document).not.toContain('?.');
    expect(document).not.toContain('??');
    expect(document).toContain('data-(?:[\\w-]+-)?action');
    expect(document).toContain(`/api/v1/card-packages/${id}/files/assets/photo.png`);
    expect(document.indexOf('<base')).toBeLessThan(document.indexOf('<title>'));
  });
});
