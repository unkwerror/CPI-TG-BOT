import { describe, expect, it } from 'vitest';
import { cardPackageErrorDocument, prepareCardPackageDocument } from './card-package-document';

describe('desktop card-package document', () => {
  it('adds a restrictive srcdoc policy and preserves fullscreen mode', () => {
    const document = prepareCardPackageDocument(
      '<!doctype html><html><head><base href="/api/v1/card-packages/id/files/"></head><body><img src="photo.png"></body></html>',
      'https://artifacts.example.test/path',
      true,
    );
    expect(document).toContain('http-equiv="Content-Security-Policy"');
    expect(document).toContain('script-src https://artifacts.example.test');
    expect(document).toContain('dataset.cpiDisplay="fullscreen"');
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('<base'));
  });

  it('creates a retry bridge instead of an empty grey document', () => {
    const document = cardPackageErrorDocument('package-id');
    expect(document).toContain('Не удалось открыть ZIP-оформление');
    expect(document).toContain('cpi-card-retry');
    expect(document).toContain('packageId:"package-id"');
  });
});
