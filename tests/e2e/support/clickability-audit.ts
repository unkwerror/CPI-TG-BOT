import type { Locator, Page, TestInfo } from '@playwright/test';

export interface InteractiveAuditItem {
  index: number;
  tag: string;
  role: string;
  name: string;
  href: string | null;
  visible: boolean;
  inViewport: boolean;
  disabled: boolean;
  inert: boolean;
  blocked: boolean;
  blockedBy: string | null;
  tooSmall: boolean;
  width: number;
  height: number;
  reasons: string[];
}

export interface InteractiveAuditOptions {
  minWidth?: number;
  minHeight?: number;
  inspectReactHandlers?: boolean;
}

type AuditRoot = Page | Locator;

const interactiveSelector = [
  'a',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  'label[for]',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Read-only inventory: it never activates, focuses, or scrolls a control. */
export async function auditInteractiveElements(
  root: AuditRoot,
  options: InteractiveAuditOptions = {},
): Promise<InteractiveAuditItem[]> {
  return root.locator(interactiveSelector).evaluateAll((elements, auditOptions) => {
    const minWidth = auditOptions.minWidth ?? 44;
    const minHeight = auditOptions.minHeight ?? 44;
    const inspectReactHandlers = auditOptions.inspectReactHandlers ?? true;

    const labelledText = (element: HTMLElement) => {
      const labelledBy = element.getAttribute('aria-labelledby');
      if (!labelledBy) return '';
      return labelledBy
        .split(/\s+/u)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ');
    };

    const elementName = (element: HTMLElement) =>
      element.getAttribute('aria-label')?.trim() ||
      labelledText(element) ||
      element.innerText.trim() ||
      element.getAttribute('title')?.trim() ||
      '';

    const reactActionEvidence = (element: HTMLElement) => {
      if (!inspectReactHandlers) return false;
      const key = Object.keys(element).find((candidate) => candidate.startsWith('__reactProps$'));
      if (!key) return false;
      const props = (element as unknown as Record<string, unknown>)[key];
      if (!props || typeof props !== 'object') return false;
      const values = props as Record<string, unknown>;
      return [
        'onClick',
        'onPointerUp',
        'onPointerDown',
        'onMouseUp',
        'onMouseDown',
        'onKeyDown',
        'onKeyUp',
      ].some((name) => typeof values[name] === 'function');
    };

    const descriptor = (element: Element | null) => {
      if (!element) return null;
      const id = element.id ? `#${element.id}` : '';
      const className =
        typeof element.className === 'string' && element.className.trim()
          ? `.${element.className.trim().split(/\s+/u).slice(0, 2).join('.')}`
          : '';
      return `${element.tagName.toLowerCase()}${id}${className}`;
    };

    return elements.map((candidate, index) => {
      const element = candidate as HTMLElement;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const href = element instanceof HTMLAnchorElement ? element.getAttribute('href') : null;
      const role = element.getAttribute('role') ?? element.tagName.toLowerCase();
      const hiddenByStyle =
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number.parseFloat(style.opacity || '1') === 0;
      const visible = rect.width > 0 && rect.height > 0 && !hiddenByStyle;
      const inViewport =
        visible &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;
      const nativeDisabled =
        ((element instanceof HTMLButtonElement ||
          element instanceof HTMLInputElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLTextAreaElement) &&
          element.disabled) ||
        element.getAttribute('aria-disabled') === 'true';
      const disabled = nativeDisabled || Boolean(element.closest('[inert]'));
      const reasons: string[] = [];

      if (style.pointerEvents === 'none' && !disabled) reasons.push('pointer-events-none');
      if (element instanceof HTMLAnchorElement) {
        const normalizedHref = href?.trim() ?? '';
        if (!normalizedHref || normalizedHref === '#' || /^javascript:/iu.test(normalizedHref)) {
          reasons.push('invalid-or-empty-href');
        }
      }
      if (element.getAttribute('role') === 'button' && element.tabIndex < 0 && !disabled) {
        reasons.push('role-button-not-keyboard-focusable');
      }

      const isSubmitButton =
        element instanceof HTMLButtonElement &&
        (element.type === 'submit' || element.type === 'reset') &&
        Boolean(element.form);
      const isNativeControl =
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement ||
        (element instanceof HTMLElement && element.tagName === 'SUMMARY') ||
        (element instanceof HTMLLabelElement && Boolean(element.htmlFor));
      const hasActionEvidence =
        element instanceof HTMLAnchorElement ||
        isNativeControl ||
        isSubmitButton ||
        typeof element.onclick === 'function' ||
        reactActionEvidence(element) ||
        element.hasAttribute('popovertarget') ||
        element.hasAttribute('commandfor');
      if (visible && !disabled && !hasActionEvidence) reasons.push('no-action-handler-evidence');

      let blocked = false;
      let blockedBy: string | null = null;
      if (inViewport && !disabled && style.pointerEvents !== 'none') {
        const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
        const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
        const topElement = document.elementFromPoint(x, y);
        if (topElement && topElement !== element && !element.contains(topElement)) {
          blocked = true;
          blockedBy = descriptor(topElement);
          reasons.push('blocked-at-center-point');
        }
      }

      let effectiveRect = rect;
      if (
        element instanceof HTMLInputElement &&
        (element.type === 'checkbox' || element.type === 'radio')
      ) {
        const associatedLabel =
          element.closest('label') ??
          (element.id
            ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(element.id)}"]`)
            : null);
        const labelRect = associatedLabel?.getBoundingClientRect();
        if (labelRect && labelRect.width > 0 && labelRect.height > 0) effectiveRect = labelRect;
      }
      const tooSmall =
        visible &&
        !disabled &&
        // The associated form control is audited separately. A text label may
        // legitimately be shorter than the minimum pointer target.
        !(element instanceof HTMLLabelElement) &&
        (effectiveRect.width < minWidth || effectiveRect.height < minHeight);
      if (tooSmall) reasons.push('click-target-below-minimum');

      return {
        index,
        tag: element.tagName.toLowerCase(),
        role,
        name: elementName(element),
        href,
        visible,
        inViewport,
        disabled,
        inert:
          !disabled &&
          reasons.some((reason) =>
            [
              'pointer-events-none',
              'invalid-or-empty-href',
              'role-button-not-keyboard-focusable',
              'no-action-handler-evidence',
            ].includes(reason),
          ),
        blocked,
        blockedBy,
        tooSmall,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
        reasons,
      };
    });
  }, options);
}

export async function attachInteractiveAudit(
  testInfo: TestInfo,
  name: string,
  items: InteractiveAuditItem[],
): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(items, null, 2)),
    contentType: 'application/json',
  });
}

export function assertInteractiveAuditClean(items: InteractiveAuditItem[]): void {
  const defects = items.filter(
    (item) => item.visible && !item.disabled && (item.inert || item.blocked || item.tooSmall),
  );
  if (defects.length > 0) {
    throw new Error(`Interactive audit found defects:\n${JSON.stringify(defects, null, 2)}`);
  }
}
