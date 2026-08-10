import { describe, expect, it } from 'vitest';
import { buildXlsxBuffer } from '@cpi/spreadsheet';
import type { AudienceRow } from './audience';
import { audienceSheet, exportFileName } from './audience-export';

function row(overrides: Partial<AudienceRow> = {}): AudienceRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    telegramUserId: '77123456',
    telegramUsername: 'ivanov',
    telegramName: 'Иван Иванов',
    fullName: 'Иванов Иван Иванович',
    phone: '+7 999 000-11-22',
    organization: 'НГУ',
    position: 'Студент',
    source: 'bot',
    status: 'active',
    botStartedAt: new Date('2026-08-01T10:00:00.000Z'),
    botBlockedAt: null,
    consentAt: null,
    lastSeenAt: new Date('2026-08-05T10:00:00.000Z'),
    crmPersonId: null,
    crmSyncedAt: null,
    crmSyncError: 'В профиле Locker не указано полное ФИО русскими буквами',
    eventCount: 1,
    submissionCount: 2,
    artifactCount: 3,
    totalBytes: 4_096,
    joinedAt: null,
    lastSubmissionAt: null,
    ...overrides,
  };
}

describe('audienceSheet', () => {
  it('keeps a row per user and names the sheet for the bot audience', () => {
    const sheet = audienceSheet([row(), row({ id: '22222222-2222-4222-8222-222222222222' })]);
    expect(sheet.name).toBe('Пользователи бота');
    expect(sheet.rows).toHaveLength(2);
  });

  it('translates the source into a readable label', () => {
    const [first] = audienceSheet([row({ source: 'bot' })]).rows as Array<{ source: string }>;
    expect(first?.source).toBe('Бот');
  });

  // Excel исполняет значение, начинающееся с @, поэтому username идёт без него.
  it('stores the username without the at sign', () => {
    const [first] = audienceSheet([row()]).rows as Array<{ username: string | null }>;
    expect(first?.username).toBe('ivanov');
  });
});

describe('audience workbook', () => {
  it('produces a file Excel recognises as a workbook', async () => {
    const workbook = await buildXlsxBuffer([audienceSheet([row()])]);
    // ZIP-контейнер xlsx всегда начинается с сигнатуры PK.
    expect(workbook.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(workbook.includes(Buffer.from('xl/workbook.xml'))).toBe(true);
    expect(workbook.byteLength).toBeGreaterThan(500);
  });
});

describe('exportFileName', () => {
  it('stamps the file with a filesystem-safe time', () => {
    expect(exportFileName('users', 'xlsx', new Date('2026-08-10T11:22:33.000Z'))).toBe(
      'users-2026-08-10T11-22-33.xlsx',
    );
  });
});
