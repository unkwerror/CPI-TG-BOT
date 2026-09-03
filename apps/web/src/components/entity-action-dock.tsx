'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function EntityActionDock({
  label,
  detail,
  children,
  className = '',
}: {
  label: string;
  detail?: string;
  children: ReactNode;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) return null;

  return createPortal(
    <aside
      className={`entity-action-dock ${className}`.trim()}
      aria-label="Основное действие"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="entity-action-dock__copy">
        <strong>{label}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
      <div className="entity-action-dock__actions">{children}</div>
    </aside>,
    document.body,
  );
}

export function EntityBackButton({
  label,
  onClick,
  className = '',
}: {
  label: string;
  onClick: () => void;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) return null;

  return createPortal(
    <button
      className={`entity-back-button ${className}`.trim()}
      type="button"
      aria-label={`Вернуться: ${label}`}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      <span aria-hidden="true">←</span>
      {label}
    </button>,
    document.body,
  );
}
