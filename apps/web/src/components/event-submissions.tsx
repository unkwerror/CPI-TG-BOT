'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Spinner } from '@cpi/ui';
import { api } from '../lib/api';
import { formatNovosibirskDateTime } from '../lib/dates';
import { downloadMessengerFile, openExternalLink } from '../lib/messenger-adapter';
import type { ArtifactItem, SubmissionItem } from '../lib/types';
import { FilesIcon, LinkIcon } from './icons';

const submissionStatusLabels: Record<string, string> = {
  draft: 'Принято',
  processing: 'Проверяется',
  ready: 'Готово',
  failed: 'Нужна повторная загрузка',
};

const artifactStatusLabels: Record<string, string> = {
  created: 'Создан',
  uploading: 'Загружается',
  uploaded: 'Загружен',
  verifying: 'Проверяется',
  ready: 'Готов',
  failed: 'Ошибка',
  quarantined: 'На проверке',
  deleted: 'Удалён',
};

const pendingSubmissionStatuses = new Set(['draft', 'processing']);
const pendingArtifactStatuses = new Set(['created', 'uploading', 'uploaded', 'verifying']);

function statusClass(status: string): string {
  if (status === 'ready') return 'active';
  if (status === 'failed') return 'error';
  return 'processing';
}

function submissionTitle(submission: SubmissionItem): string {
  if (submission.title) return submission.title;
  if (submission.artifacts?.length) return 'Файлы';
  if (submission.link) return 'Ссылка';
  if (submission.text) return 'Заметка';
  return 'Отправка';
}

function textPreview(value: string): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} КБ`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} МБ`;
  return `${(value / 1024 ** 3).toFixed(1)} ГБ`;
}

function countLabel(value: number, forms: [string, string, string]): string {
  const lastTwo = value % 100;
  const last = value % 10;
  const form =
    lastTwo >= 11 && lastTwo <= 14
      ? forms[2]
      : last === 1
        ? forms[0]
        : last >= 2 && last <= 4
          ? forms[1]
          : forms[2];
  return `${value} ${form}`;
}

function FileArtifact({
  artifact,
  downloading,
  onDownload,
}: {
  artifact: ArtifactItem;
  downloading: boolean;
  onDownload: (artifact: ArtifactItem) => void;
}) {
  return (
    <div className="event-artifact-row">
      <FilesIcon />
      <div>
        <strong>{artifact.displayName}</strong>
        <span>{formatBytes(artifact.sizeBytes)}</span>
        {artifact.statusReason ? <small>{artifact.statusReason}</small> : null}
      </div>
      <span className={`artifact-status ${statusClass(artifact.status)}`}>
        {artifactStatusLabels[artifact.status] ?? artifact.status}
      </span>
      {artifact.status === 'ready' ? (
        <Button type="button" disabled={downloading} onClick={() => onDownload(artifact)}>
          {downloading ? 'Открываем…' : 'Скачать'}
        </Button>
      ) : null}
    </div>
  );
}

export function EventSubmissions({
  eventId,
  refreshRevision,
}: {
  eventId: string;
  refreshRevision: number;
}) {
  const [items, setItems] = useState<SubmissionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api<{ items: SubmissionItem[] }>(`/events/${eventId}/submissions`);
      setItems(response.items);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось загрузить ваши артефакты');
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load, refreshRevision]);

  const hasPendingItems = items.some(
    (submission) =>
      pendingSubmissionStatuses.has(submission.status) ||
      submission.artifacts?.some((artifact) => pendingArtifactStatuses.has(artifact.status)),
  );

  useEffect(() => {
    if (!hasPendingItems) return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [hasPendingItems, load]);

  const artifactCount = useMemo(
    () => items.reduce((total, submission) => total + (submission.artifacts?.length ?? 0), 0),
    [items],
  );

  const openSubmissionLink = (url: string) => {
    setActionError(null);
    if (!openExternalLink(url)) setActionError('Ссылка имеет неподдерживаемый формат');
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

  return (
    <Card className="event-submissions" aria-labelledby="event-submissions-title">
      <div className="event-submissions-heading">
        <div>
          <p className="eyebrow">Ваши материалы</p>
          <h2 id="event-submissions-title">
            {loading
              ? 'Проверяем отправки'
              : items.length > 0
                ? 'Уже отправлено'
                : 'Пока нет отправок'}
          </h2>
        </div>
        {!loading && items.length > 0 ? (
          <span>
            {countLabel(items.length, ['отправка', 'отправки', 'отправок'])} ·{' '}
            {countLabel(artifactCount, ['файл', 'файла', 'файлов'])}
          </span>
        ) : null}
      </div>

      {actionError ? (
        <div className="event-submissions-error" role="alert">
          <p>{actionError}</p>
        </div>
      ) : null}

      {loading ? (
        <div className="event-submissions-loading">
          <Spinner label="Загружаем отправленные артефакты" />
        </div>
      ) : error ? (
        <div className="event-submissions-error">
          <p>{error}</p>
          <Button type="button" onClick={() => void load()}>
            Повторить
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="event-submissions-empty">
          <strong>Вы ещё ничего не отправляли</strong>
          <span>Первая заметка, ссылка или файл появится здесь сразу после отправки.</span>
        </div>
      ) : (
        <div className="event-submissions-list">
          {items.map((submission) => (
            <article className="event-submission-item" key={submission.id}>
              <header>
                <div>
                  <span className={`status-pill ${statusClass(submission.status)}`}>
                    {submissionStatusLabels[submission.status] ?? submission.status}
                  </span>
                  <h3>{submissionTitle(submission)}</h3>
                </div>
                <time dateTime={submission.createdAt}>
                  {formatNovosibirskDateTime(submission.createdAt)}
                </time>
              </header>

              {submission.text ? (
                <div className="event-text-artifact">
                  <span>Текст</span>
                  <p>{textPreview(submission.text)}</p>
                </div>
              ) : null}
              {submission.link ? (
                <button
                  className="event-link-artifact"
                  type="button"
                  onClick={() => openSubmissionLink(submission.link!)}
                >
                  <LinkIcon />
                  <span>
                    <small>Ссылка</small>
                    <strong>{submission.link}</strong>
                  </span>
                </button>
              ) : null}
              {submission.artifacts?.length ? (
                <div className="event-artifact-list">
                  {submission.artifacts.map((artifact) => (
                    <FileArtifact
                      artifact={artifact}
                      downloading={downloadingId === artifact.id}
                      onDownload={(item) => void download(item)}
                      key={artifact.id}
                    />
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </Card>
  );
}
