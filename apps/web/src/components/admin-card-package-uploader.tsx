'use client';

import { useRef, useState } from 'react';
import { api, uploadWithHeadersAndProgress } from '../lib/api';
import { getMessengerAdapter } from '../lib/messenger-adapter';
import { CardPackageFrame } from './rich-html';

type CardPackageEntityType = 'event' | 'product' | 'feed_post';

interface CardPackageUploadInit {
  packageId: string;
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresInSeconds: number;
}

interface CardPackageComplete {
  cardPackageId: string;
  package: {
    id: string;
    fileName: string;
    sizeBytes: number;
    fileCount: number;
    totalUncompressedBytes: number;
  };
}

function packageError(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось применить ZIP-оформление';
}

export function AdminCardPackageUploader({
  entityType,
  entityId,
  packageId,
  title,
  onApplied,
  onRemoved,
}: {
  entityType: CardPackageEntityType;
  entityId: string | null;
  packageId: string | null;
  title: string;
  onApplied: (packageId: string) => void;
  onRemoved: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<'success' | 'error'>('success');

  const upload = async (file: File) => {
    if (!entityId) {
      setMessageTone('error');
      setMessage('Сначала сохраните запись как черновик, затем загрузите ZIP.');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setMessageTone('error');
      setMessage('Нужен файл с расширением .zip');
      return;
    }
    if (file.size <= 0 || file.size > 30 * 1024 * 1024) {
      setMessageTone('error');
      setMessage('Размер ZIP должен быть от 1 байта до 30 МБ.');
      return;
    }
    setUploading(true);
    setProgress(0);
    setMessage(null);
    try {
      const initialized = await api<CardPackageUploadInit>('/admin/card-packages/uploads', {
        method: 'POST',
        body: JSON.stringify({
          entityType,
          entityId,
          fileName: file.name,
          sizeBytes: file.size,
        }),
      });
      await uploadWithHeadersAndProgress(
        initialized.uploadUrl,
        file,
        initialized.method,
        initialized.headers,
        (loaded, total) => setProgress(total > 0 ? Math.round((loaded / total) * 90) : 0),
      );
      setProgress(92);
      const completed = await api<CardPackageComplete>('/admin/card-packages/complete', {
        method: 'POST',
        body: JSON.stringify({
          packageId: initialized.packageId,
          entityType,
          entityId,
          fileName: file.name,
          sizeBytes: file.size,
        }),
      });
      setProgress(100);
      onApplied(completed.cardPackageId);
      setMessageTone('success');
      setMessage(
        `ZIP применён: ${completed.package.fileCount} файлов, ${(completed.package.totalUncompressedBytes / 1024 / 1024).toFixed(1)} МБ после распаковки.`,
      );
    } catch (error) {
      setMessageTone('error');
      setMessage(packageError(error));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async () => {
    if (!packageId || uploading) return;
    setUploading(true);
    setMessage(null);
    try {
      await api(`/admin/card-packages/${encodeURIComponent(packageId)}`, {
        method: 'DELETE',
      });
      onRemoved();
      setProgress(0);
      setMessageTone('success');
      setMessage('ZIP-оформление удалено. Используется стандартная карточка.');
    } catch (error) {
      setMessageTone('error');
      setMessage(packageError(error));
    } finally {
      setUploading(false);
    }
  };

  const downloadSource = async () => {
    if (!packageId) return;
    try {
      const source = await api<{ url: string }>(
        `/admin/card-packages/${encodeURIComponent(packageId)}/source`,
      );
      const messenger = getMessengerAdapter();
      if (messenger) messenger.openLink(source.url);
      else window.open(source.url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setMessageTone('error');
      setMessage(packageError(error));
    }
  };

  return (
    <fieldset className="admin-wide card-package-uploader" disabled={uploading}>
      <legend>ZIP-оформление карточки</legend>
      <div className="card-package-uploader__intro">
        <div>
          <strong>Готовый веб-пакет</strong>
          <p>
            Поддерживаются обычный сайт с <code>index.html</code> и модуль с
            <code>manifest.json</code>, где заданы <code>entry</code>, <code>style</code> и{' '}
            <code>script</code>. CSS, JS-анимации, изображения, шрифты и видео кладите внутрь ZIP с
            относительными путями. Архив и ресурсы сохраняются в Beget S3.
          </p>
          {entityType === 'product' ? (
            <p>
              Загруженное отдельно фото остаётся обложкой товара в каталоге. В открытой карточке
              показываются изображения только из ZIP.
            </p>
          ) : null}
        </div>
        <label className="secondary-button compact-button">
          {uploading ? 'Обрабатываем…' : packageId ? 'Заменить ZIP' : 'Загрузить ZIP'}
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            disabled={!entityId || uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </label>
      </div>
      {!entityId ? <small>Сначала сохраните запись — ZIP привязывается к её ID.</small> : null}
      {uploading || progress > 0 ? (
        <progress max={100} value={progress} aria-label="Загрузка ZIP" />
      ) : null}
      {message ? <div className={`notice ${messageTone}`}>{message}</div> : null}
      {packageId ? (
        <>
          <div className="card-package-uploader__preview">
            <CardPackageFrame
              packageId={packageId}
              title={`ZIP-оформление: ${title}`}
              interactive
            />
          </div>
          <div className="card-package-uploader__actions">
            <button type="button" onClick={() => void downloadSource()}>
              Скачать исходный ZIP
            </button>
            <button type="button" onClick={() => void remove()}>
              Удалить ZIP-оформление
            </button>
          </div>
        </>
      ) : null}
    </fieldset>
  );
}
