import { describe, expect, it } from 'vitest';
import { eventCreateSchema, eventFieldsSchema, eventUpdateSchema } from '@cpi/shared';
import { createEventValues, updateEventValues } from './event-values';

const fullBody = {
  title: 'Форум разработчиков',
  slug: 'forum-razrabotchikov',
  shortCode: 'FORUM',
  description: 'Описание',
  organizer: 'Студия',
  startsAt: '2026-09-01T10:00:00+07:00',
  endsAt: '2026-09-02T18:00:00+07:00',
  venue: 'Технопарк',
  city: 'Новосибирск',
  format: 'offline',
  status: 'published',
  tags: ['форум'],
  coverUrl: 'https://example.com/cover.png',
  acceptUploadsFrom: '2026-09-01T10:00:00+07:00',
  acceptUploadsUntil: '2026-09-10T18:00:00+07:00',
  maxFileSizeBytes: 1_048_576,
  allowedMimeTypes: ['image/png'],
  blockedExtensions: ['exe'],
  directAccessEnabled: false,
  acceptsRequests: true,
};

describe('event field mapping', () => {
  /**
   * Флаг «принимает запросы» однажды потерялся именно здесь: поле было в схеме и в
   * форме, но не попадало в INSERT, поэтому галочка молча снималась после сохранения.
   */
  it('переносит в базу каждое поле схемы', () => {
    const values = createEventValues(eventCreateSchema.parse(fullBody), 'user-1');
    const missing = Object.keys(eventFieldsSchema.shape).filter((key) => !(key in values));
    expect(missing).toEqual([]);
  });

  it('сохраняет включённый приём запросов при создании', () => {
    const values = createEventValues(eventCreateSchema.parse(fullBody), 'user-1');
    expect(values.acceptsRequests).toBe(true);
  });

  it('сохраняет приём запросов при обновлении', () => {
    const enabled = updateEventValues(eventUpdateSchema.parse({ acceptsRequests: true }), 'user-1');
    expect(enabled.acceptsRequests).toBe(true);
    const disabled = updateEventValues(
      eventUpdateSchema.parse({ acceptsRequests: false }),
      'user-1',
    );
    expect(disabled.acceptsRequests).toBe(false);
  });

  /** Кнопка «Скрыть» присылает только status — остальные поля трогать нельзя. */
  it('не трогает приём запросов при частичном обновлении', () => {
    const values = updateEventValues(eventUpdateSchema.parse({ status: 'finished' }), 'user-1');
    expect('acceptsRequests' in values).toBe(false);
    expect('directAccessEnabled' in values).toBe(false);
    expect(values.status).toBe('finished');
  });
});
