export function readApiError(
  payload: unknown,
  fallback = 'Не удалось выполнить запрос',
): { code: string; message: string } {
  if (!payload || typeof payload !== 'object') {
    return { code: 'REQUEST_FAILED', message: fallback };
  }
  const body = payload as {
    error?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (body.error && typeof body.error === 'object') {
    const nested = body.error as { code?: unknown; message?: unknown };
    if (typeof nested.message === 'string' && nested.message.trim()) {
      return {
        code: typeof nested.code === 'string' && nested.code ? nested.code : 'REQUEST_FAILED',
        message: nested.message,
      };
    }
  }
  if (typeof body.message === 'string' && body.message.trim()) {
    return {
      code: typeof body.code === 'string' && body.code ? body.code : 'REQUEST_FAILED',
      message: body.message,
    };
  }
  return { code: 'REQUEST_FAILED', message: fallback };
}
