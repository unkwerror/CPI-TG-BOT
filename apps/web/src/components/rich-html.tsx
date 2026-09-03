'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  cardPackageErrorDocument,
  cardPackageLoadingDocument,
  prepareCardPackageDocument,
} from '../lib/card-package-document';
import { openExternalLink } from '../lib/messenger-adapter';

export type CardPackageFields = Record<string, string>;

let telegramSwipeLocks = 0;
let restoreTelegramVerticalSwipes = false;
const cardPackageScrollRelays = new WeakMap<
  HTMLIFrameElement,
  { deltaY: number; animationFrame: number }
>();

function lockTelegramVerticalSwipes(): () => void {
  const telegram = window.Telegram?.WebApp;
  if (!telegram?.disableVerticalSwipes) return () => undefined;
  if (telegramSwipeLocks === 0) {
    restoreTelegramVerticalSwipes = telegram.isVerticalSwipesEnabled !== false;
    try {
      telegram.expand();
      telegram.disableVerticalSwipes();
    } catch {
      restoreTelegramVerticalSwipes = false;
      return () => undefined;
    }
  }
  telegramSwipeLocks += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    telegramSwipeLocks = Math.max(0, telegramSwipeLocks - 1);
    if (telegramSwipeLocks === 0 && restoreTelegramVerticalSwipes) {
      try {
        telegram.enableVerticalSwipes?.();
      } catch {
        // Older Telegram Desktop clients can expose the method without
        // supporting the corresponding WebApp event. The ZIP must stay open.
      }
    }
  };
}

function normalizeCardPackageFields(value: unknown): CardPackageFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: CardPackageFields = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(normalized).length >= 20) break;
    if (typeof rawValue !== 'string') continue;
    const key = rawKey.replace(/\s+/gu, ' ').trim().slice(0, 80);
    if (/^(?:cpiDisplay|jsAnimation)$/iu.test(key)) continue;
    const fieldValue = rawValue.replace(/\s+/gu, ' ').trim().slice(0, 300);
    if (key && fieldValue) normalized[key] = fieldValue;
  }
  return normalized;
}

function openCardPackageLink(value: unknown, onInternalLink?: (href: string) => boolean): boolean {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  let url: URL;
  try {
    url = new URL(value, window.location.origin);
  } catch {
    return false;
  }
  if (url.origin === window.location.origin && onInternalLink) {
    const internalHref = `${url.pathname}${url.search}${url.hash}`;
    if (onInternalLink(internalHref)) return true;
  }
  if (url.origin === window.location.origin) {
    const internalHref = `${url.pathname}${url.search}${url.hash}`;
    const navigationEvent = new CustomEvent('cpi:app-link', {
      cancelable: true,
      detail: { href: internalHref },
    });
    window.dispatchEvent(navigationEvent);
    if (navigationEvent.defaultPrevented) return true;
  }
  if (url.origin === window.location.origin && ['http:', 'https:'].includes(url.protocol)) {
    window.location.assign(url.toString());
    return true;
  }
  return openExternalLink(value);
}

function relayCardPackageScroll(frame: HTMLIFrameElement, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  const deltaY = Math.max(-240, Math.min(240, value));
  if (Math.abs(deltaY) < 0.5) return;

  const relay = cardPackageScrollRelays.get(frame) ?? {
    deltaY: 0,
    animationFrame: 0,
  };
  relay.deltaY = Math.max(-480, Math.min(480, relay.deltaY + deltaY));
  cardPackageScrollRelays.set(frame, relay);
  if (relay.animationFrame) return;

  relay.animationFrame = window.requestAnimationFrame(() => {
    relay.animationFrame = 0;
    const nextDeltaY = relay.deltaY;
    relay.deltaY = 0;
    let container: HTMLElement | null = frame.parentElement;
    while (container && container !== document.body) {
      const overflowY = window.getComputedStyle(container).overflowY;
      if (
        /^(?:auto|scroll|overlay)$/u.test(overflowY) &&
        container.scrollHeight > container.clientHeight + 1
      ) {
        container.scrollBy({ top: nextDeltaY, behavior: 'auto' });
        return;
      }
      container = container.parentElement;
    }
    window.scrollBy({ top: nextDeltaY, behavior: 'auto' });
  });
}

const shadowFoundation = `<style>
  :host {
    display: block;
    position: relative;
    width: 100%;
    max-width: 100%;
    overflow: hidden;
    isolation: isolate;
    color: inherit;
    font: inherit;
    line-height: inherit;
  }
  *, *::before, *::after { box-sizing: border-box; }
  img, video, canvas, svg { max-width: 100%; }
</style>`;

export function RichHtml({
  html,
  className = '',
  onAction,
  onLink,
}: {
  html: string;
  className?: string;
  onAction?: () => void;
  onLink?: (href: string) => boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    root.innerHTML = `${shadowFoundation}${html}`;
    setLinkError(null);
    const handleClick = (event: Event) => {
      const anchor = event
        .composedPath()
        .find((item): item is HTMLAnchorElement => item instanceof HTMLAnchorElement);
      if (!anchor) return;
      event.stopPropagation();
      const href = anchor.getAttribute('href')?.trim() ?? '';
      if ((!href || href === '#') && onAction) {
        event.preventDefault();
        onAction();
        return;
      }
      event.preventDefault();
      if (!href || href === '#') {
        setLinkError('Для этой кнопки действие пока не настроено');
        return;
      }
      if (href.startsWith('#')) {
        let targetId: string;
        try {
          targetId = decodeURIComponent(href.slice(1));
        } catch {
          setLinkError('Ссылка имеет неподдерживаемый формат');
          return;
        }
        const target = [...root.querySelectorAll<HTMLElement>('[id]')].find(
          (element) => element.id === targetId,
        );
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          return;
        }
        if (onLink?.(href)) return;
        setLinkError('Раздел по этой ссылке не найден');
        return;
      }
      if (openCardPackageLink(href, onLink)) return;
      setLinkError('Ссылка имеет неподдерживаемый формат');
    };
    root.addEventListener('click', handleClick);
    return () => root.removeEventListener('click', handleClick);
  }, [html, onAction, onLink]);

  return (
    <>
      <div ref={hostRef} className={`rich-html-host ${className}`.trim()} />
      {linkError ? (
        <p className="rich-html-link-error" role="alert">
          {linkError}
        </p>
      ) : null}
    </>
  );
}

export function CardPackageFrame({
  packageId,
  title,
  compact = false,
  interactive = false,
  fullscreen = false,
  onAction,
  onFieldsChange,
  onLink,
}: {
  packageId: string;
  title: string;
  compact?: boolean;
  interactive?: boolean;
  fullscreen?: boolean;
  onAction?: (fields: CardPackageFields) => void;
  onFieldsChange?: (fields: CardPackageFields) => void;
  onLink?: (href: string) => boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const onActionRef = useRef(onAction);
  const onFieldsChangeRef = useRef(onFieldsChange);
  const onLinkRef = useRef(onLink);
  const [height, setHeight] = useState(compact ? 320 : 520);
  const [documentHtml, setDocumentHtml] = useState(cardPackageLoadingDocument);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [renderMode, setRenderMode] = useState<'srcdoc' | 'direct'>(
    interactive ? 'srcdoc' : 'direct',
  );
  const nativeScroll = interactive && fullscreen;
  const packageMessageReceivedRef = useRef(false);
  const renderUrl = `/api/v1/card-packages/${encodeURIComponent(packageId)}/render?renderer=native-scroll-v2${fullscreen ? '&display=fullscreen' : ''}`;
  const directRenderUrl = `${renderUrl}${renderUrl.includes('?') ? '&' : '?'}cpi_fallback=${loadAttempt + 1}`;

  useLayoutEffect(() => {
    onActionRef.current = onAction;
    onFieldsChangeRef.current = onFieldsChange;
    onLinkRef.current = onLink;
  }, [onAction, onFieldsChange, onLink]);

  useEffect(() => {
    if (!interactive) return;
    return lockTelegramVerticalSwipes();
  }, [interactive]);

  useEffect(() => {
    if (!interactive) return;
    const controller = new AbortController();
    let active = true;
    setDocumentHtml(cardPackageLoadingDocument());
    void fetch(renderUrl, {
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`ZIP render failed with status ${response.status}`);
        }
        return response.text();
      })
      .then((html) => {
        if (!active) return;
        setDocumentHtml(prepareCardPackageDocument(html, window.location.origin, fullscreen));
      })
      .catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) {
          return;
        }
        setDocumentHtml(cardPackageErrorDocument(packageId));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [fullscreen, interactive, loadAttempt, packageId]);

  useEffect(() => {
    if (!interactive) return;
    packageMessageReceivedRef.current = false;
    setRenderMode('srcdoc');
  }, [interactive, loadAttempt, packageId]);

  useEffect(() => {
    if (!interactive || renderMode !== 'srcdoc') return;
    const timeout = window.setTimeout(() => {
      if (!packageMessageReceivedRef.current) setRenderMode('direct');
    }, 3_500);
    return () => window.clearTimeout(timeout);
  }, [interactive, loadAttempt, packageId, renderMode]);

  useLayoutEffect(() => {
    const receiveHeight = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const payload = event.data as {
        type?: unknown;
        packageId?: unknown;
        height?: unknown;
        fields?: unknown;
        href?: unknown;
        deltaY?: unknown;
      } | null;
      if (!payload || payload.packageId !== packageId) return;
      packageMessageReceivedRef.current = true;
      if (payload.type === 'cpi-card-height' && nativeScroll) return;
      if (payload.type === 'cpi-card-retry') {
        setLoadAttempt((attempt) => attempt + 1);
        return;
      }
      const fields = normalizeCardPackageFields(payload.fields);
      if (payload.type === 'cpi-card-link') {
        openCardPackageLink(payload.href, onLinkRef.current);
        return;
      }
      if (payload.type === 'cpi-card-scroll' && interactive) {
        const frame = frameRef.current;
        if (frame) relayCardPackageScroll(frame, payload.deltaY);
        return;
      }
      if (payload.type === 'cpi-card-action') {
        onFieldsChangeRef.current?.(fields);
        onActionRef.current?.(fields);
        return;
      }
      if (payload.type === 'cpi-card-fields') {
        onFieldsChangeRef.current?.(fields);
        return;
      }
      if (
        payload.type === 'cpi-card-height' &&
        !nativeScroll &&
        typeof payload.height === 'number' &&
        Number.isFinite(payload.height)
      ) {
        setHeight(Math.max(120, Math.min(compact ? 1_200 : 50_000, payload.height)));
      }
    };
    window.addEventListener('message', receiveHeight);
    return () => window.removeEventListener('message', receiveHeight);
  }, [compact, interactive, nativeScroll, packageId]);

  return (
    <iframe
      key={`${packageId}:${interactive ? renderMode : 'direct'}:${loadAttempt}`}
      ref={frameRef}
      className={`card-package-frame${compact ? ' card-package-frame--compact' : ''}${interactive ? ' card-package-frame--interactive' : ''}${fullscreen ? ' card-package-frame--fullscreen' : ''}${nativeScroll ? ' card-package-frame--native-scroll' : ''}`}
      src={interactive ? (renderMode === 'srcdoc' ? undefined : directRenderUrl) : renderUrl}
      srcDoc={interactive && renderMode === 'srcdoc' ? documentHtml : undefined}
      data-render-mode={interactive ? renderMode : 'direct'}
      title={title}
      sandbox="allow-scripts"
      scrolling={nativeScroll ? 'yes' : 'no'}
      referrerPolicy="no-referrer"
      loading={interactive ? 'eager' : 'lazy'}
      tabIndex={interactive ? 0 : -1}
      aria-hidden={interactive ? undefined : true}
      style={{ height: nativeScroll ? '100dvh' : height }}
    />
  );
}

export function HtmlDesignPreview({
  html,
  title = 'Предпросмотр HTML-оформления',
}: {
  html: string;
  title?: string;
}) {
  return (
    <iframe
      className="card-package-frame card-package-frame--preview"
      srcDoc={html}
      title={title}
      sandbox=""
      referrerPolicy="no-referrer"
    />
  );
}
