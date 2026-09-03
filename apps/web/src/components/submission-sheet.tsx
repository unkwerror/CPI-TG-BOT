'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { m } from 'motion/react';
import { Button, Card } from '@cpi/ui';
import type { UploadInitResponse } from '@cpi/shared';
import { api, ApiClientError, uploadWithProgress, withRetry } from '../lib/api';
import { getMessengerAdapter } from '../lib/messenger-adapter';
import type {
  EventArtifactField,
  EventArtifactForm,
  EventItem,
  SubmissionItem,
} from '../lib/types';
import { CatAssistant } from './cat-assistant';
import { CloseIcon, FilesIcon, LinkIcon, UploadIcon } from './icons';

interface SelectedFile {
  id: string;
  file: File;
  progress: number;
  status: 'selected' | 'uploading' | 'done' | 'error';
  error?: string;
  artifactId?: string;
  formFieldId?: string;
}

interface Draft {
  title: string;
  text: string;
  link: string;
  submissionKey: string;
  uploadKeys: Record<string, string>;
  fieldValues: Record<string, string | boolean>;
}

const newDraft = (): Draft => ({
  title: '',
  text: '',
  link: '',
  submissionKey: crypto.randomUUID(),
  uploadKeys: {},
  fieldValues: {},
});

const FILE_FIELD_KINDS = new Set(['file', 'image', 'document', 'audio', 'video', 'archive']);

function isFileField(field: EventArtifactField): boolean {
  return FILE_FIELD_KINDS.has(field.kind);
}

function fieldAccept(field: EventArtifactField): string | undefined {
  const values = [
    ...field.allowedMimeTypes,
    ...field.allowedExtensions.map((extension) =>
      extension.startsWith('.') ? extension : `.${extension}`,
    ),
  ];
  return values.length > 0 ? values.join(',') : undefined;
}

function fingerprint(file: File, formFieldId?: string): string {
  return `${formFieldId ?? 'legacy'}:${file.name}:${file.size}:${file.lastModified}`;
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
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SubmissionItem | null>(null);
  const [artifactForm, setArtifactForm] = useState<EventArtifactForm | null>(null);
  const [formLoading, setFormLoading] = useState(true);
  const activeRequests = useRef(new Set<XMLHttpRequest>());
  const artifactIds = useRef(new Set<string>());
  const cancelledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setFormLoading(true);
    void api<EventArtifactForm | null>(`/events/${encodeURIComponent(event.id)}/form`)
      .then((form) => {
        if (!cancelled) setArtifactForm(form);
      })
      .catch(() => {
        if (!cancelled) setArtifactForm(null);
      })
      .finally(() => {
        if (!cancelled) setFormLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [event.id]);

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
    const messenger = getMessengerAdapter();
    messenger?.setClosingConfirmation(submitting);
    return () => messenger?.setClosingConfirmation(false);
  }, [submitting]);

  const overallProgress = useMemo(() => {
    if (files.length === 0) return 0;
    const total = files.reduce((sum, item) => sum + item.file.size, 0);
    const loaded = files.reduce((sum, item) => sum + item.file.size * (item.progress / 100), 0);
    return total === 0 ? 0 : Math.round((loaded / total) * 100);
  }, [files]);

  const chooseFiles = (inputEvent: ChangeEvent<HTMLInputElement>, field?: EventArtifactField) => {
    const requested = [...(inputEvent.target.files ?? [])];
    const currentCount = field ? files.filter((item) => item.formFieldId === field.id).length : 0;
    const maxItems = field ? Math.max(1, field.maxItems) : Number.POSITIVE_INFINITY;
    const permitted = requested.filter((file) => {
      const maxSize = field?.maxFileSizeBytes ?? event.maxFileSizeBytes;
      if (file.size > maxSize) {
        setError(`${file.name}: размер больше ${formatBytes(maxSize)}`);
        return false;
      }
      if (!field) return true;
      const extension = file.name.includes('.')
        ? (file.name.split('.').pop()?.toLowerCase() ?? '')
        : '';
      const allowedExtensions = field.allowedExtensions.map((value) =>
        value.replace(/^\./, '').toLowerCase(),
      );
      const mimeAllowed =
        field.allowedMimeTypes.length === 0 ||
        field.allowedMimeTypes.some((value) => {
          if (value.endsWith('/*')) return file.type.startsWith(value.slice(0, -1));
          return file.type === value;
        });
      const extensionAllowed =
        allowedExtensions.length === 0 || allowedExtensions.includes(extension);
      if (!mimeAllowed || !extensionAllowed) {
        setError(`${file.name}: формат не подходит для поля «${field.label}»`);
        return false;
      }
      return true;
    });
    const nextFiles = permitted.slice(0, Math.max(0, maxItems - currentCount));
    if (permitted.length > nextFiles.length) {
      setError(`Для поля «${field?.label ?? 'Файлы'}» можно выбрать не больше ${maxItems}`);
    }
    setFiles((current) => [
      ...current,
      ...nextFiles.map((file) => ({
        id: crypto.randomUUID(),
        file,
        progress: 0,
        status: 'selected' as const,
        ...(field ? { formFieldId: field.id } : {}),
      })),
    ]);
    setDraft((current) => {
      const uploadKeys = { ...current.uploadKeys };
      for (const file of nextFiles)
        uploadKeys[fingerprint(file, field?.id)] ??= crypto.randomUUID();
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
      draft.uploadKeys[fingerprint(selected.file, selected.formFieldId)] ?? crypto.randomUUID();
    const initialized = await api<UploadInitResponse>('/uploads/init', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({
        submissionId,
        fileName: selected.file.name,
        mimeType: selected.file.type || 'application/octet-stream',
        sizeBytes: selected.file.size,
        lastModified: selected.file.lastModified,
        ...(selected.formFieldId ? { formFieldId: selected.formFieldId } : {}),
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
        if (cancelledRef.current)
          throw new ApiClientError('Загрузка отменена', 'UPLOAD_ABORTED', 0);
        const partNumber = index + 1;
        const { url } = await api<{ url: string }>(
          `/uploads/${initialized.artifactId}/part-url?partNumber=${partNumber}`,
        );
        const blob = selected.file.slice(
          index * partSize,
          Math.min((index + 1) * partSize, selected.file.size),
        );
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
    const dynamicValues: Array<{ fieldId: string; textValue?: string; jsonValue?: boolean }> = [];
    for (const field of artifactForm?.fields ?? []) {
      if (isFileField(field)) continue;
      const value = draft.fieldValues[field.id];
      if (field.kind === 'checkbox') {
        dynamicValues.push({ fieldId: field.id, jsonValue: Boolean(value) });
        continue;
      }
      const textValue = typeof value === 'string' ? value.trim() : '';
      if (textValue) dynamicValues.push({ fieldId: field.id, textValue });
    }
    if (artifactForm) {
      for (const field of artifactForm.fields) {
        if (isFileField(field)) {
          const count = files.filter((item) => item.formFieldId === field.id).length;
          const minimum = field.required ? Math.max(1, field.minItems) : field.minItems;
          if (count < minimum) {
            setError(`Поле «${field.label}»: приложите минимум ${minimum} файл(а)`);
            return;
          }
          continue;
        }
        const value = draft.fieldValues[field.id];
        if (
          field.required &&
          (field.kind === 'checkbox' ? value !== true : !String(value ?? '').trim())
        ) {
          setError(`Заполните обязательное поле «${field.label}»`);
          return;
        }
      }
    } else if (!draft.title && !draft.text && !draft.link && files.length === 0) {
      setError('Добавьте текст, ссылку или хотя бы один файл');
      return;
    }
    setSubmitting(true);
    cancelledRef.current = false;
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
          ...(artifactForm ? { formVersionId: artifactForm.id, fieldValues: dynamicValues } : {}),
        }),
      });
      for (const selected of files) await uploadOne(selected, submission.id);
      const completed = {
        ...submission,
        status: files.length ? ('processing' as const) : submission.status,
      };
      setSuccess(completed);
      localStorage.removeItem(storageKey);
      setDraft(newDraft());
      getMessengerAdapter()?.notify('success');
      onSuccess(completed);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Не удалось отправить материалы';
      setError(message);
      setFiles((current) =>
        current.map((item) =>
          item.status === 'uploading' ? { ...item, status: 'error', error: message } : item,
        ),
      );
      getMessengerAdapter()?.notify('error');
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    cancelledRef.current = true;
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
      <m.div
        className="sheet-backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="success-title"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <m.section
          className="bottom-sheet success-sheet"
          initial={{ opacity: 0, y: 46, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 46 }}
        >
          <CatAssistant
            mood="success"
            title="Ура, всё принято!"
            message={
              files.length
                ? 'Теперь я проверю файлы. Их статус уже появился в карточке мероприятия.'
                : 'Заметка уже у организатора и появилась в карточке мероприятия.'
            }
            live
          />
          <h2 id="success-title">Материалы приняты</h2>
          <p>
            {files.length
              ? 'Файлы загружены и проходят проверку. Статус обновится прямо в карточке мероприятия.'
              : 'Заметка сохранена и уже доступна организатору.'}
          </p>
          <Button className="primary-button" type="button" onClick={onClose}>
            Готово
          </Button>
        </m.section>
      </m.div>
    );
  }

  return (
    <m.div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="submit-title"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <m.section
        className="bottom-sheet"
        initial={{ opacity: 0, y: 54, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 54, scale: 0.99 }}
        transition={{ type: 'spring', stiffness: 420, damping: 40 }}
      >
        <div className="sheet-handle" />
        <button
          className="icon-button sheet-close"
          type="button"
          onClick={onClose}
          aria-label="Закрыть"
        >
          <CloseIcon />
        </button>
        <div className="sheet-heading">
          <span className="event-code">{event.shortCode}</span>
          <h2 id="submit-title">Добавить артефакт</h2>
          <p>{event.title}</p>
        </div>
        <CatAssistant
          compact
          live
          mood={submitting || files.length > 0 ? 'upload' : 'talk'}
          message={
            submitting
              ? `Загружаю и ничего не теряю — уже ${overallProgress}%. Не закрывайте окно.`
              : files.length > 0
                ? `Выбрано файлов: ${files.length}. Добавьте описание или сразу отправляйте.`
                : 'Можно приложить несколько файлов, ссылку и заметку в одной отправке.'
          }
        />
        <form className="form-stack" onSubmit={submit}>
          {formLoading ? (
            <div className="form-loading">
              <span /> Загружаем форму…
            </div>
          ) : null}
          {artifactForm ? (
            <div className="dynamic-artifact-form">
              <header>
                <span>Форма · версия {artifactForm.version}</span>
                <h3>{artifactForm.title}</h3>
                {artifactForm.instructions ? <p>{artifactForm.instructions}</p> : null}
              </header>
              {artifactForm.fields.map((field) => {
                const value = draft.fieldValues[field.id];
                if (field.kind === 'checkbox') {
                  return (
                    <label className="artifact-checkbox-field" key={field.id}>
                      <input
                        type="checkbox"
                        checked={value === true}
                        required={field.required}
                        onChange={(inputEvent) =>
                          setDraft((current) => ({
                            ...current,
                            fieldValues: {
                              ...current.fieldValues,
                              [field.id]: inputEvent.target.checked,
                            },
                          }))
                        }
                      />
                      <span>
                        <strong>
                          {field.label}
                          {field.required ? ' *' : ''}
                        </strong>
                        {field.description ? <small>{field.description}</small> : null}
                      </span>
                    </label>
                  );
                }
                if (isFileField(field)) {
                  const selectedCount = files.filter(
                    (item) => item.formFieldId === field.id,
                  ).length;
                  const maxSize = field.maxFileSizeBytes ?? event.maxFileSizeBytes;
                  return (
                    <div className="artifact-file-field" key={field.id}>
                      <div>
                        <strong>
                          {field.label}
                          {field.required ? ' *' : ''}
                        </strong>
                        {field.description ? <p>{field.description}</p> : null}
                      </div>
                      <label className="file-picker">
                        <UploadIcon />
                        <strong>
                          {selectedCount > 0 ? `Выбрано: ${selectedCount}` : 'Выбрать файлы'}
                        </strong>
                        <span>
                          До {field.maxItems} шт. · до {formatBytes(maxSize)} каждый
                        </span>
                        <input
                          type="file"
                          multiple={field.maxItems > 1}
                          accept={fieldAccept(field)}
                          onChange={(inputEvent) => chooseFiles(inputEvent, field)}
                          disabled={submitting || selectedCount >= field.maxItems}
                        />
                      </label>
                    </div>
                  );
                }
                const stringValue = typeof value === 'string' ? value : '';
                return (
                  <label key={field.id}>
                    <span>
                      {field.label}
                      {field.required ? ' *' : ''}
                    </span>
                    {field.kind === 'text' && (field.config.maxLength ?? 0) > 500 ? (
                      <textarea
                        value={stringValue}
                        required={field.required}
                        minLength={field.config.minLength}
                        maxLength={field.config.maxLength}
                        rows={4}
                        placeholder={field.config.placeholder ?? field.description ?? undefined}
                        onChange={(inputEvent) =>
                          setDraft((current) => ({
                            ...current,
                            fieldValues: {
                              ...current.fieldValues,
                              [field.id]: inputEvent.target.value,
                            },
                          }))
                        }
                      />
                    ) : (
                      <input
                        type={field.kind === 'link' ? 'url' : 'text'}
                        value={stringValue}
                        required={field.required}
                        minLength={field.config.minLength}
                        maxLength={field.config.maxLength}
                        placeholder={
                          field.config.placeholder ??
                          field.description ??
                          (field.kind === 'link' ? 'https://' : undefined)
                        }
                        onChange={(inputEvent) =>
                          setDraft((current) => ({
                            ...current,
                            fieldValues: {
                              ...current.fieldValues,
                              [field.id]: inputEvent.target.value,
                            },
                          }))
                        }
                      />
                    )}
                    {field.description && field.config.placeholder ? (
                      <small>{field.description}</small>
                    ) : null}
                  </label>
                );
              })}
            </div>
          ) : null}
          {!artifactForm && !formLoading ? (
            <>
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
            </>
          ) : null}

          {files.length > 0 ? (
            <div className="selected-files">
              {files.map((selected) => (
                <Card className="selected-file" key={selected.id}>
                  <FilesIcon />
                  <div>
                    <strong title={selected.file.name}>{selected.file.name}</strong>
                    <span>
                      {formatBytes(selected.file.size)}
                      {selected.formFieldId && artifactForm
                        ? ` · ${artifactForm.fields.find((field) => field.id === selected.formFieldId)?.label ?? 'Поле формы'}`
                        : ''}
                      {selected.status === 'done' ? ' · загружен' : ''}
                    </span>
                    {selected.status === 'uploading' || selected.status === 'done' ? (
                      <div
                        className="progress-track"
                        aria-label={`Загружено ${selected.progress}%`}
                      >
                        <m.span
                          initial={false}
                          animate={{ width: `${selected.progress}%` }}
                          transition={{ type: 'spring', stiffness: 160, damping: 28 }}
                        />
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
            <m.div
              className="overall-progress"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div>
                <strong>Загружаем материалы</strong>
                <span>{overallProgress}%</span>
              </div>
              <div className="progress-track">
                <m.span
                  initial={false}
                  animate={{ width: `${overallProgress}%` }}
                  transition={{ type: 'spring', stiffness: 150, damping: 26 }}
                />
              </div>
            </m.div>
          ) : null}
          {error ? <div className="notice error">{error}</div> : null}
          <div className="sheet-actions">
            {submitting ? (
              <Button type="button" className="secondary-button" onClick={() => void cancel()}>
                Отменить
              </Button>
            ) : null}
            <Button className="primary-button" type="submit" disabled={submitting}>
              {submitting
                ? 'Отправляем…'
                : (artifactForm?.submitButtonLabel ?? 'Отправить материалы')}
            </Button>
          </div>
        </form>
      </m.section>
    </m.div>
  );
}
