import { describe, expect, it } from 'vitest';
import { formatRequestNotice, noticeDeduplicationKey, type RequestNotice } from './request-notice';

function notice(overrides: Partial<RequestNotice> = {}): RequestNotice {
  return {
    requestId: '11111111-1111-4111-8111-111111111111',
    eventTitle: 'ТОП-1000 университетских проектов',
    authorName: 'Иванов Иван Иванович',
    authorUsername: 'ivanov',
    authorPhone: '+79130000000',
    telegramUserId: '77123456',
    text: 'Нужна помощь с заполнением заявки',
    attachmentCount: 0,
    version: 1_786_464_000_000,
    ...overrides,
  };
}

describe('formatRequestNotice', () => {
  it('shows the event, the author with contacts and the text', () => {
    const message = formatRequestNotice(notice());
    expect(message).toContain('Новый запрос: ТОП-1000 университетских проектов');
    expect(message).toContain('От: Иванов Иван Иванович (@ivanov, +79130000000)');
    expect(message).toContain('Нужна помощь с заполнением заявки');
  });

  it('omits the contact brackets when nothing is known', () => {
    const message = formatRequestNotice(notice({ authorUsername: null, authorPhone: null }));
    expect(message).toContain('От: Иванов Иван Иванович\n');
    expect(message).not.toContain('()');
  });

  it('mentions attachments only when they exist', () => {
    expect(formatRequestNotice(notice())).not.toContain('Вложений');
    expect(formatRequestNotice(notice({ attachmentCount: 2 }))).toContain('Вложений: 2');
  });
});

describe('noticeDeduplicationKey', () => {
  it('separates recipients so everyone gets the request', () => {
    expect(noticeDeduplicationKey(notice(), 'manager-a')).not.toBe(
      noticeDeduplicationKey(notice(), 'manager-b'),
    );
  });

  // Дополнение к запросу меняет версию: иначе повторное уведомление считалось
  // бы доставленным и команда не узнала бы о новом сообщении.
  it('changes when the request is updated', () => {
    expect(noticeDeduplicationKey(notice({ version: 2 }), 'manager-a')).not.toBe(
      noticeDeduplicationKey(notice({ version: 3 }), 'manager-a'),
    );
  });
});
