'use client';

import type { AuthResponse } from '@cpi/shared';

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(value: string): void {
  csrfToken = value;
  sessionStorage.setItem('csrfToken', value);
}

function getCsrfToken(): string | null {
  csrfToken ??= sessionStorage.getItem('csrfToken');
  return csrfToken;
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
  options?: { csrf?: boolean },
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const needsCsrf = options?.csrf ?? !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (needsCsrf) {
    const token = getCsrfToken();
    if (token) headers.set('x-csrf-token', token);
  }
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as
    T | { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiClientError(
      error?.message ?? 'Не удалось выполнить запрос',
      error?.code ?? 'REQUEST_FAILED',
      response.status,
    );
  }
  return payload as T;
}

export async function authenticate(): Promise<AuthResponse> {
  try {
    const session = await api<AuthResponse>('/auth/session');
    setCsrfToken(session.csrfToken);
    return session;
  } catch (error) {
    if (!(error instanceof ApiClientError) || error.status !== 401) throw error;
  }
  const initData = window.Telegram?.WebApp.initData;
  if (initData) {
    const result = await api<AuthResponse>(
      '/auth/telegram',
      { method: 'POST', body: JSON.stringify({ initData }) },
      { csrf: false },
    );
    setCsrfToken(result.csrfToken);
    return result;
  }
  if (process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED === 'true') {
    const result = await api<AuthResponse>(
      '/auth/dev',
      { method: 'POST', body: JSON.stringify({}) },
      { csrf: false },
    );
    setCsrfToken(result.csrfToken);
    return result;
  }
  throw new ApiClientError(
    'Откройте приложение кнопкой из Telegram-бота',
    'TELEGRAM_CONTEXT_REQUIRED',
    401,
  );
}

export function uploadWithProgress(
  url: string,
  body: Blob,
  contentType: string,
  onProgress: (loaded: number, total: number) => void,
  register?: (xhr: XMLHttpRequest) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    register?.(xhr);
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', contentType);
    xhr.upload.onprogress = (event) => onProgress(event.loaded, event.total || body.size);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.getResponseHeader('etag') ?? '');
      } else {
        reject(
          new ApiClientError(`Хранилище ответило ${xhr.status}`, 'S3_UPLOAD_FAILED', xhr.status),
        );
      }
    };
    xhr.onerror = () =>
      reject(new ApiClientError('Потеряна сеть при загрузке', 'NETWORK_ERROR', 0));
    xhr.onabort = () => reject(new ApiClientError('Загрузка отменена', 'UPLOAD_ABORTED', 0));
    xhr.send(body);
  });
}

export async function withRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error instanceof ApiClientError && error.code === 'UPLOAD_ABORTED') throw error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}
