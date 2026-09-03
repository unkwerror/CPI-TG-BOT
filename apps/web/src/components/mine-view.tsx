'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Card } from '@cpi/ui';
import { api } from '../lib/api';
import { formatNovosibirskDate, formatNovosibirskDateTime } from '../lib/dates';
import { downloadMessengerFile, openExternalLink } from '../lib/messenger-adapter';
import type { ArtifactItem, SubmissionItem } from '../lib/types';
import { CatAssistant } from './cat-assistant';
import { FilesIcon, LinkIcon } from './icons';

const statusLabels: Record<string, string> = {
  draft: 'Черновик',
  processing: 'Проверяется',
  ready: 'Готово',
  failed: 'Нужна повторная загрузка',
  created: 'Создан',
  uploading: 'Загружается',
  uploaded: 'Загружен',
  verifying: 'Проверяется',
  quarantined: 'В карантине',
  deleted: 'Удалён',
};

export function MineView() {
  const [items, setItems] = useState<SubmissionItem[]>([]);
  const [selected, setSelected] = useState<SubmissionItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api<{ items: SubmissionItem[] }>('/me/submissions');
      setItems(response.items);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось загрузить материалы');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasPendingItems = items.some((item) => ['draft', 'processing'].includes(item.status));

  useEffect(() => {
    if (!hasPendingItems) return;
    const timer = setInterval(() => {
      void load();
    }, 5_000);
    return () => clearInterval(timer);
  }, [hasPendingItems, load]);

  const showDetails = async (submission: SubmissionItem) => {
    setActionError(null);
    try {
      const details = await api<SubmissionItem>(`/me/submissions/${submission.id}`);
      setSelected({ ...submission, ...details });
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Не удалось открыть отправку');
    }
  };

  const download = async (artifact: ArtifactItem) => {
    setActionError(null);
    setDownloadingId(artifact.id);
    try {
      const result = await api<{ url: string }>(`/artifacts/${artifact.id}/download`);
      if (!downloadMessengerFile(result.url, artifact.displayName)) {
        throw new Error('Ссылка на файл недоступна');
      }
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Не удалось скачать файл');
    } finally {
      setDownloadingId(null);
    }
  };

  const openSubmissionLink = (url: string) => {
    setActionError(null);
    if (!openExternalLink(url)) setActionError('Ссылка имеет неподдерживаемый формат');
  };

  if (selected) {
    return (
      <section className="screen">
        <button
          className="text-button back-button"
          type="button"
          onClick={() => {
            setSelected(null);
            setActionError(null);
          }}
        >
          ← Все материалы
        </button>
        <header className="screen-header compact">
          <p className="eyebrow">{selected.event?.title}</p>
          <h1>{selected.title || 'Отправка'}</h1>
          <p>{formatNovosibirskDateTime(selected.createdAt)} · Новосибирск</p>
        </header>
        <CatAssistant
          compact
          mood={selected.status === 'ready' ? 'success' : 'upload'}
          message={
            selected.status === 'ready'
              ? 'Всё готово: проверенные файлы можно скачать ниже.'
              : 'Я слежу за проверкой. Статус обновится автоматически.'
          }
        />
        {selected.text ? <Card className="submission-text">{selected.text}</Card> : null}
        {actionError ? (
          <div className="notice error" role="alert">
            {actionError}
          </div>
        ) : null}
        {selected.link ? (
          <button
            className="link-card"
            type="button"
            onClick={() => openSubmissionLink(selected.link!)}
          >
            <LinkIcon /> {selected.link}
          </button>
        ) : null}
        <div className="file-list">
          {selected.artifacts?.map((artifact) => (
            <Card className="file-row" key={artifact.id}>
              <FilesIcon />
              <div>
                <strong>{artifact.displayName}</strong>
                <span>
                  {formatBytes(artifact.sizeBytes)} ·{' '}
                  {statusLabels[artifact.status] ?? artifact.status}
                </span>
                {artifact.statusReason ? <small>{artifact.statusReason}</small> : null}
              </div>
              {artifact.status === 'ready' ? (
                <Button
                  type="button"
                  disabled={downloadingId === artifact.id}
                  onClick={() => void download(artifact)}
                >
                  {downloadingId === artifact.id ? 'Открываем…' : 'Скачать'}
                </Button>
              ) : null}
            </Card>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="screen" aria-labelledby="mine-title">
      <header className="screen-header">
        <p className="eyebrow">История</p>
        <h1 id="mine-title">Мои материалы</h1>
        <p>Здесь отображаются все отправки и состояние проверки файлов.</p>
      </header>
      <CatAssistant
        compact
        live
        mood={loading ? 'search' : items.length === 0 ? 'sleep' : 'idle'}
        message={
          loading
            ? 'Проверяю ваши отправки и статусы файлов…'
            : items.length === 0
              ? 'Пока можно полежать. Первая отправка появится здесь сразу после загрузки.'
              : 'Я слежу за проверкой файлов. Если статус изменится, список обновится сам.'
        }
      />
      {error ? <div className="notice error">{error}</div> : null}
      {actionError ? (
        <div className="notice error" role="alert">
          {actionError}
        </div>
      ) : null}
      {loading ? (
        <div className="skeleton event-skeleton" />
      ) : items.length === 0 ? (
        <div className="empty-state cat-empty-state compact-empty-state">
          <h2>Материалов пока нет</h2>
          <p>Откройте мероприятие и сделайте первую отправку.</p>
        </div>
      ) : (
        <div className="submission-list">
          {items.map((submission) => (
            <button
              className="card-button"
              type="button"
              key={submission.id}
              onClick={() => void showDetails(submission)}
            >
              <Card className="submission-card">
                <div>
                  <span className={`status-pill ${submission.status === 'ready' ? 'active' : ''}`}>
                    {statusLabels[submission.status] ?? submission.status}
                  </span>
                  <h2>{submission.title || submission.event?.title || 'Материалы'}</h2>
                  <p>
                    {submission.artifactCount ?? 0} файл(а) ·{' '}
                    {formatNovosibirskDate(submission.createdAt)}
                  </p>
                </div>
                <span aria-hidden="true">›</span>
              </Card>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} КБ`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} МБ`;
  return `${(value / 1024 ** 3).toFixed(1)} ГБ`;
}
