'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Card } from '@cpi/ui';
import { api } from '../lib/api';
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
    const timer = setInterval(() => {
      if (items.some((item) => ['draft', 'processing'].includes(item.status))) void load();
    }, 5_000);
    return () => clearInterval(timer);
  }, [load, items]);

  const showDetails = async (submission: SubmissionItem) => {
    const details = await api<SubmissionItem>(`/me/submissions/${submission.id}`);
    setSelected({ ...submission, ...details });
  };

  const download = async (artifact: ArtifactItem) => {
    const result = await api<{ url: string }>(`/artifacts/${artifact.id}/download`);
    window.location.assign(result.url);
  };

  if (selected) {
    return (
      <section className="screen">
        <button className="text-button back-button" type="button" onClick={() => setSelected(null)}>
          ← Все материалы
        </button>
        <header className="screen-header compact">
          <p className="eyebrow">{selected.event?.title}</p>
          <h1>{selected.title || 'Отправка'}</h1>
          <p>{new Date(selected.createdAt).toLocaleString('ru-RU')}</p>
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
        {selected.link ? (
          <a className="link-card" href={selected.link} target="_blank" rel="noreferrer">
            <LinkIcon /> {selected.link}
          </a>
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
                <Button type="button" onClick={() => void download(artifact)}>
                  Скачать
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
                    {new Date(submission.createdAt).toLocaleDateString('ru-RU')}
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
