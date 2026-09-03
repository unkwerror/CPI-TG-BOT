import { describe, expect, it } from 'vitest';
import { readApiError } from './api-error';

describe('readApiError', () => {
  it('reads the nested API error contract', () => {
    expect(
      readApiError({ error: { code: 'INSUFFICIENT_POINTS', message: 'Недостаточно баллов' } }),
    ).toEqual({ code: 'INSUFFICIENT_POINTS', message: 'Недостаточно баллов' });
  });

  it('reads Fastify default errors that expose message at the top level', () => {
    expect(
      readApiError({
        statusCode: 409,
        code: 'QR_EXPIRED',
        error: 'Conflict',
        message: 'QR-код уже использован или истёк',
      }),
    ).toEqual({ code: 'QR_EXPIRED', message: 'QR-код уже использован или истёк' });
  });

  it('falls back when the body is empty or HTML', () => {
    expect(readApiError(null).message).toBe('Не удалось выполнить запрос');
    expect(readApiError('<html></html>').message).toBe('Не удалось выполнить запрос');
  });
});
