import sanitizeHtml from 'sanitize-html';
import { parse } from 'postcss';

export type RichContentFormat = 'text' | 'html';

const MAX_STYLESHEET_LENGTH = 100_000;
const safeAtRules = new Set(['media', 'supports', 'keyframes', '-webkit-keyframes']);
const unsafeCssValue =
  /(?:\\|(?:url|image|image-set|cross-fade|element|paint|src|expression)\s*\(|javascript\s*:|vbscript\s*:|data\s*:|@import|-moz-binding|behavior\s*:)/iu;
const unsafeSelector = /(?:\\|:host(?:-context)?|::slotted|::part|:global)/iu;

function cleanCssTree(css: string, inline = false): string {
  if (!css.trim() || css.length > MAX_STYLESHEET_LENGTH) return '';
  try {
    const root = inline ? parse(`cpi-inline{${css}}`) : parse(css);
    if (inline) {
      const [rule] = root.nodes;
      if (root.nodes.length !== 1 || rule?.type !== 'rule' || rule.selector !== 'cpi-inline') {
        return '';
      }
    }
    root.walkComments((comment) => {
      comment.remove();
    });
    root.walkAtRules((rule) => {
      const name = rule.name.toLowerCase();
      const keyframes = name === 'keyframes' || name === '-webkit-keyframes';
      if (
        inline ||
        !safeAtRules.has(name) ||
        rule.params.length > 1_000 ||
        unsafeCssValue.test(rule.params) ||
        /[{}<>]/u.test(rule.params) ||
        (keyframes && !/^[a-z_][a-z0-9_-]*$/iu.test(rule.params.trim()))
      ) {
        rule.remove();
      }
    });
    root.walkRules((rule) => {
      if (
        rule.selector.length > 2_000 ||
        unsafeSelector.test(rule.selector) ||
        /(^|[\s,>+~])(?:html|body|:root)(?=$|[\s,>+~.:#[])/iu.test(rule.selector)
      ) {
        rule.remove();
      }
    });
    root.walkDecls((declaration) => {
      const property = declaration.prop.toLowerCase();
      const value = declaration.value.trim();
      if (
        !/^(?:--[a-z0-9_-]+|-?[a-z][a-z0-9-]*)$/iu.test(property) ||
        property === 'behavior' ||
        property === '-moz-binding' ||
        unsafeCssValue.test(value) ||
        (property === 'position' && /^(?:fixed|sticky)$/iu.test(value))
      ) {
        declaration.remove();
      }
    });
    if (!inline) return root.toString().trim();
    const rule = root.first;
    if (rule?.type !== 'rule') return '';
    return rule.nodes
      .map((node) => node.toString())
      .join(';')
      .trim();
  } catch {
    return '';
  }
}

export function sanitizeRichCss(value: string): string {
  return cleanCssTree(value);
}

function sanitizeInlineCss(value: string): string {
  return cleanCssTree(value, true);
}

/**
 * Rich publication markup is authored by administrators, but it is still rendered inside every
 * participant's Telegram WebView. Custom CSS is isolated in a ShadowRoot by the web client.
 * Scripts, embeds, forms, remote CSS resources and layout primitives which could cover the
 * application UI are stripped here before the markup is persisted or returned.
 */
export function sanitizeRichHtml(value: string): string {
  const sanitized = sanitizeHtml(value, {
    allowedTags: [
      'style',
      'article',
      'section',
      'div',
      'span',
      'p',
      'br',
      'h2',
      'h3',
      'h4',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'small',
      'blockquote',
      'ul',
      'ol',
      'li',
      'a',
      'img',
      'figure',
      'figcaption',
      'hr',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'code',
      'pre',
    ],
    allowedAttributes: {
      '*': ['class', 'id', 'style', 'title', 'role', 'aria-*', 'data-*'],
      a: ['href', 'title', 'rel', 'target'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    parseStyleAttributes: false,
    allowVulnerableTags: true,
    transformTags: {
      '*': (tagName, attributes) => {
        const attribs = { ...attributes };
        if (attribs.style) {
          const style = sanitizeInlineCss(attribs.style);
          if (style) attribs.style = style;
          else delete attribs.style;
        }
        if (tagName === 'a') {
          attribs.rel = 'noopener noreferrer';
          if (attribs.target && attribs.target !== '_blank') {
            delete attribs.target;
          }
        }
        if (tagName === 'img') attribs.loading = 'lazy';
        return { tagName, attribs };
      },
    },
    nestingLimit: 20,
    enforceHtmlBoundary: true,
  });
  return sanitized
    .replace(/<style>([\s\S]*?)<\/style>/giu, (_match, css: string) => {
      const safeCss = sanitizeRichCss(css);
      return safeCss ? `<style>${safeCss}</style>` : '';
    })
    .trim();
}

export function sanitizeRichContent(value: string, format: RichContentFormat): string {
  return format === 'html' ? sanitizeRichHtml(value) : value.trim();
}

export function richContentToPlainText(value: string, format: RichContentFormat): string {
  if (format === 'text') return value.trim();
  return sanitizeHtml(sanitizeRichHtml(value), {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/\s+/gu, ' ')
    .trim();
}
