import { describe, expect, it } from 'vitest';
import {
  artifactObjectKey,
  eventStoragePrefixes,
  exportObjectKey,
  incomingObjectKey,
  publicStorageUrl,
  sanitizeFileName,
  sanitizePathSegment,
  withCopySuffix,
} from './storage-layout';

describe('storage layout', () => {
  it('keeps unchecked bytes in the locker incoming tree', () => {
    expect(
      incomingObjectKey('locker/', {
        eventId: 'event-1',
        submissionId: 'submission-1',
        artifactId: 'artifact-1',
      }),
    ).toBe('locker/incoming/event-1/submission-1/artifact-1');
  });

  it('builds a readable folder for a checked artifact', () => {
    expect(
      artifactObjectKey('locker/', {
        eventTitle: 'Регистрация ООО',
        personName: 'Иванов Иван Иванович',
        telegramUserId: 100n,
        fileName: 'Устав.PDF',
      }),
    ).toBe('locker/artifacts/Регистрация ООО/Иванов Иван Иванович/Устав.pdf');
  });

  it('falls back to the telegram account when a participant has no name', () => {
    expect(
      artifactObjectKey('locker', {
        eventTitle: '  ',
        personName: null,
        telegramUserId: '512',
        fileName: '',
      }),
    ).toBe('locker/artifacts/Без мероприятия/Без имени 512/файл');
  });

  it('strips path separators so a folder cannot escape its tree', () => {
    expect(sanitizePathSegment('../../etc')).toBe('etc');
    expect(sanitizeFileName('../secret.env')).toBe('secret.env');
    expect(
      artifactObjectKey('locker/', {
        eventTitle: 'a/b',
        personName: 'c\\d',
        telegramUserId: 1n,
        fileName: 'e/f.txt',
      }),
    ).toBe('locker/artifacts/a b/c d/e f.txt');
  });

  it('separates exports by event and job', () => {
    expect(exportObjectKey('locker/', { eventId: 'e1', exportJobId: 'j1', kind: 'zip' })).toBe(
      'locker/exports/e1/j1.zip',
    );
    expect(eventStoragePrefixes('locker/', 'e1')).toEqual([
      'locker/incoming/e1/',
      'locker/exports/e1/',
    ]);
  });

  it('numbers repeated file names instead of overwriting them', () => {
    const key = 'locker/artifacts/Событие/Иванов/Устав.pdf';
    expect(withCopySuffix(key, 1)).toBe(key);
    expect(withCopySuffix(key, 2)).toBe('locker/artifacts/Событие/Иванов/Устав (2).pdf');
    expect(withCopySuffix('locker/artifacts/Событие/Иванов/скан', 3)).toBe(
      'locker/artifacts/Событие/Иванов/скан (3)',
    );
  });

  it('moves a signed url onto our own domain without touching the signature', () => {
    const signed =
      'https://s3.example.cloud/bucket/locker/incoming/e/s/a?X-Amz-Signature=abc&X-Amz-Expires=900';
    expect(publicStorageUrl(signed, 'https://artifacts.example.org/storage')).toBe(
      'https://artifacts.example.org/storage/bucket/locker/incoming/e/s/a?X-Amz-Signature=abc&X-Amz-Expires=900',
    );
    expect(publicStorageUrl(signed, '')).toBe(signed);
  });
});
