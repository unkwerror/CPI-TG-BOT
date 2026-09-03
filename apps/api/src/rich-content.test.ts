import { describe, expect, it } from 'vitest';
import { sanitizeRichContent, sanitizeRichCss, sanitizeRichHtml } from './rich-content';

describe('sanitizeRichHtml', () => {
  it('keeps presentation markup used by publication editors', () => {
    const result = sanitizeRichHtml(
      '<section style="background-color:#ed2d8c;padding:16px"><h2>Заголовок</h2><p><strong>Текст</strong></p></section>',
    );
    expect(result).toContain('<section');
    expect(result).toContain('background-color:#ed2d8c');
    expect(result).toContain('<strong>Текст</strong>');
  });

  it('removes executable markup and unsafe attributes', () => {
    const result = sanitizeRichHtml(
      '<script>alert(1)</script><img src="https://example.test/a.jpg" onerror="alert(2)"><a href="javascript:alert(3)" onclick="alert(4)">link</a>',
    );
    expect(result).not.toContain('script');
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('onclick');
    expect(result).not.toContain('javascript:');
    expect(result).toContain('loading="lazy"');
    expect(result).toContain('rel="noopener noreferrer"');
  });

  it('keeps isolated card CSS, classes, media queries and animations', () => {
    const result = sanitizeRichHtml(`<style>
      .catalyst-merch { --cyan: #64d5d1; display:grid; background:radial-gradient(circle, rgba(100,213,209,.18), transparent 27%); }
      .catalyst-photo-card { animation:catalystFloat 5s ease-in-out infinite; }
      @keyframes catalystFloat { 50% { transform:translateY(-11px) rotate(.5deg); } }
      @media (max-width:760px) { .catalyst-merch { grid-template-columns:1fr; } }
    </style><section class="catalyst-merch" data-layout="product"><div class="catalyst-photo-card">Карточка</div></section>`);
    expect(result).toContain('<style>');
    expect(result).toContain('@keyframes catalystFloat');
    expect(result).toContain('@media (max-width:760px)');
    expect(result).toContain('class="catalyst-merch"');
    expect(result).toContain('data-layout="product"');
  });

  it('strips remote CSS, host selectors and fixed positioning', () => {
    const result = sanitizeRichHtml(`<style>
      @import url(https://evil.test/theme.css);
      :host { position:fixed; inset:0; }
      .safe { position:fixed; background-image:url(https://evil.test/pixel); color:#fff; }
      @font-face { font-family:x; src:url(https://evil.test/font.woff2); }
    </style><section class="safe" style="position:fixed;color:#fff;background:url(https://evil.test/pixel)">Текст</section>`);
    expect(result).not.toContain('@import');
    expect(result).not.toContain(':host');
    expect(result).not.toContain('@font-face');
    expect(result).not.toContain('position:fixed');
    expect(result).not.toContain('evil.test');
    expect(result).toContain('color:#fff');
  });

  it('rejects escaped CSS tokens which could bypass URL checks', () => {
    expect(sanitizeRichCss(String.raw`.card{background:u\72l(https://evil.test/a)}`)).not.toContain(
      'evil.test',
    );
  });

  it('does not interpret plain text as HTML', () => {
    expect(sanitizeRichContent('  <b>текст</b>  ', 'text')).toBe('<b>текст</b>');
  });
});
