'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { Button, Card } from '@cpi/ui';
import type { UploadInitResponse } from '@cpi/shared';
import { api, ApiClientError, uploadWithProgress, withRetry } from '../lib/api';
import type { EventItem, SubmissionItem } from '../lib/types';
import { CheckIcon, CloseIcon, FilesIcon, LinkIcon, UploadIcon } from './icons';

interface SelectedFile {
  id: string;
  file: File;
  progress: number;
  status: 'selected' | 'uploading' | 'done' | 'error';
  error?: string;
  artifactId?: string;
}

interface Draft {
  title: string;
  text: string;
  link: string;
  submissionKey: string;
  uploadKeys: Record<string, string>;
}

const newDraft = (): Draft => ({
  title: '',
  text: '',
  link: '',
  submissionKey: crypto.randomUUID(),
  uploadKeys: {},
});

function fingerprint(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} КБ`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} МБ`;
  return `${(value / 1024 ** 3).toFixed(1)} ГБ`;
}

export function SubmissionSheet({
  event,
  onClose,
  onSuccess,
}: {
  event: EventItem;
  onClose: () => void;
  onSuccess: (submission: SubmissionItem) => void;
}) {
  const storageKey = `artifact-draft:${event.id}`;
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SubmissionItem | null>(null);
  const activeRequests = useRef(new Set<XMLHttpRequest>());
  const artifactIds = useRef(new Set<string>());

  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        setDraft({ ...newDraft(), ...(JSON.parse(saved) as Partial<Draft>) });
      } catch {
        localStorage.removeItem(storageKey);
      }
    }
  }, [storageKey]);

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(draft));
  }, [draft, storageKey]);

  useEffect(() => {
    if (submitting) window.Telegram?.WebApp.enableClosingConfirmation?.();
    else window.Telegram?.WebApp.disableClosingConfirmation?.();
    return () => window.Telegram?.WebApp.disableClosingConfirmation?.();
  }, [submitting]);

  const overallProgress = useMemo(() => {
    if (files.length === 0) return 0;
    const total = files.reduce((sum, item) => sum + item.file.size, 0);
    const loaded = files.reduce((sum, item) => sum + item.file.size * (item.progress / 100), 0);
    return total === 0 ? 0 : Math.round((loaded / total) * 100);
  }, [files]);

  const chooseFiles = (inputEvent: ChangeEvent<HTMLInputElement>) => {
    const nextFiles = [...(inputEvent.target.files ?? [])];
    setFiles((current) => [
      ...current,
      ...nextFiles.map((file) => ({
        id: crypto.randomUUID(),
        file,
        progress: 0,
        status: 'selected' as const,
      })),
    ]);
    setDraft((current) => {
      const uploadKeys = { ...current.uploadKeys };
      for (const file of nextFiles) uploadKeys[fingerprint(file)] ??= crypto.randomUUID();
      return { ...current, uploadKeys };
    });
    inputEvent.target.value = '';
  };

  const patchFile = (id: string, patch: Partial<SelectedFile>) => {
    setFiles((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const uploadOne = async (selected: SelectedFile, submissionId: string) => {
    patchFile(selected.id, { status: 'uploading' });
    const idempotencyKey =
      draft.uploadKeys[fingerprint(selected.file)] ?? crypto.randomUUID();
    const initialized = await api<UploadInitResponse>('/uploads/init', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({
        submissionId,
        fileName: selected.file.name,
        mimeType: selected.file.type || 'application/octet-stream',
        sizeBytes: selected.file.size,
        lastModified: selected.file.lastModified,
      }),
    });
    artifactIds.current.add(initialized.artifactId);
    patchFile(selected.id, { artifactId: initialized.artifactId });
    if (initialized.alreadyCompleted) {
      patchFile(selected.id, { progress: 100, status: 'done' });
      return;
    }

    const register = (xhr: XMLHttpRequest) => {
      activeRequests.current.add(xhr);
      xhr.addEventListener('loadend', () => activeRequests.current.delete(xhr), { once: true });
    };
    const mime = selected.file.type || 'application/octet-stream';
    const parts: Array<{ partNumber: number; etag: string }> = [];
    if (initialized.uploadType === 'simple') {
      if (!initialized.uploadUrl) throw new Error('Хранилище не выдало ссылку загрузки');
      await withRetry(() =>
        uploadWithProgress(
          initialized.uploadUrl!,
          selected.file,
          mime,
          (loaded, total) =>
            patchFile(selected.id, { progress: Math.round((loaded / total) * 100) }),
          register,
        ),
      );
    } else {
      const partSize = initialized.partSize;
      if (!partSize) throw new Error('Не указан размер части multipart-загрузки');
      const partCount = Math.ceil(selected.file.size / partSize);
      for (let index = 0; index < partCount; index += 1) {
        if (cancelled) throw new ApiClientError('Загрузка отменена', 'UPLOAD_ABORTED', 0);
        const partNumber = index + 1;
        const { url } = await api<{ url: string }>(
          `/uploads/${initialized.artifactId}/part-url?partNumber=${partNumber}`,
        );
        const blob = selected.file.slice(index * partSize, Math.min((index + 1) * partSize, selected.file.size));
        const etag = await withRetry(() =>
          uploadWithProgress(
            url,
            blob,
            mime,
            (loaded) => {
              const completedBytes = index * partSize;
              patchFile(selected.id, {
                progress: Math.min(
                  99,
                  Math.round(((completedBytes + loaded) / selected.file.size) * 100),
                ),
              });
            },
            register,
          ),
        );
        if (!etag) throw new Error('Хранилище не вернуло ETag части');
        parts.push({ partNumber, etag });
      }
    }
    await api(`/uploads/${initialized.artifactId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ parts }),
    });
    patchFile(selected.id, { progress: 100, status: 'done' });
  };

  const submit = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    if (!draft.title && !draft.text && !draft.link && files.length === 0) {
      setError('Добавьте текст, ссылку или хотя бы один файл');
      return;
    }
    setSubmitting(true);
    setCancelled(false);
    setError(null);
    try {
      const submission = await api<SubmissionItem>(`/events/${event.id}/submissions`, {
        method: 'POST',
        headers: { 'idempotency-key': draft.submissionKey },
        body: JSON.stringify({
          title: draft.title || null,
          text: draft.text || null,
          link: draft.link || null,
          hasFiles: files.length > 0,
        }),
      });
      for (const selected of files) await uploadOne(selected, submission.id);
      const completed = { ...submission, status: files.length ? ('processing' as const) : submission.status };
      setSuccess(completed);
      localStorage.removeItem(storageKey);
      setDraft(newDraft());
      window.Telegram?.WebApp.HapticFeedback?.notificationOccurred('success');
      onSuccess(completed);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Не удалось отправить материалы';
      setError(message);
      setFiles((current) =>
        current.map((item) =>
          item.status === 'uploading' ? { ...item, status: 'error', error: message } : item,
        ),
      );
      window.Telegram?.WebApp.HapticFeedback?.notificationOccurred('error');
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    setCancelled(true);
    for (const request of activeRequests.current) request.abort();
    activeRequests.current.clear();
    await Promise.allSettled(
      [...artifactIds.current].map((artifactId) =>
        api(`/uploads/${artifactId}/abort`, { method: 'POST', body: '{}' }),
      ),
    );
    setSubmitting(false);
  };

  if (success) {
    return (
      <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="success-title">
        <section className="bottom-sheet success-sheet">
          <div className="success-mark">
            <CheckIcon />
          </div>
          <h2 id="success-title">Материалы приняты</h2>
          <p>
            {files.length
              ? 'Файлы загружены и проходят проверку. Статус обновится в разделе «Мои материалы».'
              : 'Заметка сохранена и уже доступна организатору.'}
          </p>
          <Button className="primary-button" type="button" onClick={onClose}>
            Готово
          </Button>
        </section>
      </div>
    );
  }

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="submit-title">
      <section className="bottom-sheet">
        <div className="sheet-handle" />
        <button className="icon-button sheet-close" type="button" onClick={onClose} aria-label="Закрыть">
          <CloseIcon />
        </button>
        <div className="sheet-heading">
          <span className="event-code">{event.shortCode}</span>
          <h2 id="submit-title">Добавить артефакт</h2>
          <p>{event.title}</p>
        </div>
        <form className="form-stack" onSubmit={submit}>
          <label>
            <span>Название</span>
            <input
              value={draft.title}
              onChange={(inputEvent) =>
                setDraft((current) => ({ ...current, title: inputEvent.target.value }))
              }
              maxLength={300}
              placeholder="Например, презентация команды"
            />
          </label>
          <label>
            <span>Текст или описание</span>
            <textarea
              value={draft.text}
              onChange={(inputEvent) =>
                setDraft((current) => ({ ...current, text: inputEvent.target.value }))
              }
              maxLength={50_000}
              rows={4}
              placeholder="Что важно знать об этих материалах?"
            />
          </label>
          <label>
            <span>Ссылка</span>
            <span className="input-with-icon">
              <LinkIcon />
              <input
                type="url"
                value={draft.link}
                onChange={(inputEvent) =>
                  setDraft((current) => ({ ...current, link: inputEvent.target.value }))
                }
                maxLength={2_000}
                placeholder="https://"
              />
            </span>
          </label>

          <label className="file-picker">
            <UploadIcon />
            <strong>Выбрать файлы</strong>
            <span>До {formatBytes(event.maxFileSizeBytes)} каждый</span>
            <input type="file" multiple onChange={chooseFiles} disabled={submitting} />
          </label>

          {files.length > 0 ? (
            <div className="selected-files">
              {files.map((selected) => (
                <Card className="selected-file" key={selected.id}>
                  <FilesIcon />
                  <div>
                    <strong title={selected.file.name}>{selected.file.name}</strong>
                    <span>
                      {formatBytes(selected.file.size)}
                      {selected.status === 'done' ? ' · загружен' : ''}
                    </span>
                    {selected.status === 'uploading' || selected.status === 'done' ? (
                      <div className="progress-track" aria-label={`Загружено ${selected.progress}%`}>
                        <span style={{ width: `${selected.progress}%` }} />
                      </div>
                    ) : null}
                    {selected.error ? <small className="error-text">{selected.error}</small> : null}
                  </div>
                  {!submitting ? (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Убрать ${selected.file.name}`}
                      onClick={() =>
                        setFiles((current) => current.filter((item) => item.id !== selected.id))
                      }
                    >
                      <CloseIcon />
                    </button>
                  ) : null}
                </Card>
              ))}
            </div>
          ) : null}

          {submitting ? (
            <div className="overall-progress">
              <div>
                <strong>Загружаем материалы</strong>
                <span>{overallProgress}%</span>
              </div>
              <div className="progress-track">
                <span style={{ width: `${overallProgress}%` }} />
              </div>
            </div>
          ) : null}
          {error ? <div className="notice error">{error}</div> : null}
          <div className="sheet-actions">
            {submitting ? (
              <Button type="button" className="secondary-button" onClick={() => void cancel()}>
                Отменить
              </Button>
            ) : null}
            <Button className="primary-button" type="submit" disabled={submitting}>
              {submitting ? 'Отправляем…' : 'Отправить материалы'}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
