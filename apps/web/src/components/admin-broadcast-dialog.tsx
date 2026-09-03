'use client';

import { useEffect } from 'react';
import { Button } from '@cpi/ui';

export function AdminBroadcastDialog({
  title,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  return (
    <div
      className="admin-broadcast-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!busy) onCancel();
      }}
    >
      <section
        className="admin-broadcast-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="admin-broadcast-title"
        aria-describedby="admin-broadcast-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="admin-broadcast-dialog__icon" aria-hidden="true">
          ↗
        </span>
        <div>
          <p className="eyebrow">Рассылка в Telegram и MAX</p>
          <h2 id="admin-broadcast-title">Отправить «{title}»?</h2>
          <p id="admin-broadcast-description">
            Сообщение получат все активные пользователи бота. Если этот материал уже рассылался, они
            получат его повторно.
          </p>
        </div>
        <div className="admin-broadcast-dialog__actions">
          <Button type="button" disabled={busy} onClick={onCancel} autoFocus>
            Отмена
          </Button>
          <Button type="button" className="primary-button" disabled={busy} onClick={onConfirm}>
            {busy ? 'Ставим в очередь…' : 'Отправить рассылку'}
          </Button>
        </div>
      </section>
    </div>
  );
}
