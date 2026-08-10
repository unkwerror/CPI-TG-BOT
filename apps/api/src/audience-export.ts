import type { SpreadsheetColumn, SpreadsheetSheet } from '@cpi/spreadsheet';
import { AUDIENCE_SOURCE_LABELS, type AudienceRow } from './audience';

export interface AudienceExportRow {
  fullName: string | null;
  telegramName: string | null;
  telegramUserId: string;
  username: string | null;
  phone: string | null;
  organization: string | null;
  position: string | null;
  source: string;
  botStartedAt: Date | null;
  botBlockedAt: Date | null;
  consentAt: Date | null;
  lastSeenAt: Date;
  eventCount: number;
  submissionCount: number;
  artifactCount: number;
  totalBytes: number;
  crmPersonId: string | null;
  crmSyncedAt: Date | null;
  crmSyncError: string | null;
}

function audienceExportColumns(): SpreadsheetColumn<AudienceExportRow>[] {
  return [
    { header: 'ФИО', key: 'fullName', width: 30 },
    { header: 'Имя в Telegram', key: 'telegramName', width: 24 },
    { header: 'Telegram ID', key: 'telegramUserId', width: 18 },
    { header: 'Username', key: 'username', width: 20 },
    { header: 'Телефон', key: 'phone', width: 18 },
    { header: 'Организация', key: 'organization', width: 28 },
    { header: 'Должность', key: 'position', width: 24 },
    { header: 'Источник', key: 'source', width: 14 },
    { header: 'Первый контакт с ботом', key: 'botStartedAt', width: 22 },
    { header: 'Заблокировал бота', key: 'botBlockedAt', width: 22 },
    { header: 'Согласие получено', key: 'consentAt', width: 22 },
    { header: 'Последняя активность', key: 'lastSeenAt', width: 22 },
    { header: 'Мероприятий', key: 'eventCount', width: 13 },
    { header: 'Отправок', key: 'submissionCount', width: 11 },
    { header: 'Файлов', key: 'artifactCount', width: 10 },
    { header: 'Объём, байт', key: 'totalBytes', width: 16 },
    { header: 'ID в CRM', key: 'crmPersonId', width: 38 },
    { header: 'Выгружен в CRM', key: 'crmSyncedAt', width: 22 },
    { header: 'Причина отказа CRM', key: 'crmSyncError', width: 50 },
  ];
}

function toExportRow(row: AudienceRow): AudienceExportRow {
  return {
    fullName: row.fullName,
    telegramName: row.telegramName,
    telegramUserId: row.telegramUserId,
    // Excel считает строку с @ формулой, поэтому имя пользователя идёт как есть.
    username: row.telegramUsername,
    phone: row.phone,
    organization: row.organization,
    position: row.position,
    source: AUDIENCE_SOURCE_LABELS[row.source] ?? row.source,
    botStartedAt: row.botStartedAt,
    botBlockedAt: row.botBlockedAt,
    consentAt: row.consentAt,
    lastSeenAt: row.lastSeenAt,
    eventCount: row.eventCount,
    submissionCount: row.submissionCount,
    artifactCount: row.artifactCount,
    totalBytes: row.totalBytes,
    crmPersonId: row.crmPersonId,
    crmSyncedAt: row.crmSyncedAt,
    crmSyncError: row.crmSyncError,
  };
}

/** Лист со всей аудиторией бота: и участники мероприятий, и просто нажавшие «Старт». */
export function audienceSheet(rows: readonly AudienceRow[]): SpreadsheetSheet {
  return {
    name: 'Пользователи бота',
    columns: audienceExportColumns(),
    rows: rows.map(toExportRow),
  };
}

export function exportFileName(prefix: string, extension: string, at = new Date()): string {
  const stamp = at.toISOString().slice(0, 19).replaceAll(':', '-');
  return `${prefix}-${stamp}.${extension}`;
}

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
