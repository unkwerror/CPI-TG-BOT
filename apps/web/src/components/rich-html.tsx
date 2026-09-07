'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { openExternalLink } from '../lib/messenger-adapter';

function openRichContentLink(value: unknown, onInternalLink?: (href: string) => boolean): boolean {
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
      if (openRichContentLink(href, onLink)) return;
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
