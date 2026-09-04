import { describe, expect, it } from 'vitest';
import {
  CATALYST_OPENING_BROADCAST_ID,
  CATALYST_OPENING_REMINDER_BROADCAST_ID,
  catalystOpeningBroadcastParts,
  catalystOpeningReminderBroadcastParts,
} from './catalyst-opening-broadcast.js';

describe('Catalyst opening broadcast', () => {
  it('builds the approved three-part Telegram campaign', () => {
    const parts = catalystOpeningBroadcastParts('https://app.example.test/');

    expect(CATALYST_OPENING_BROADCAST_ID).toBe('catalyst-opening-2026-09-03-v1');
    expect(parts.map((part) => part.id)).toEqual(['announcement', 'registration', 'chat']);
    expect(parts[1]?.message).toContain('Подключиться к Catalyst и получить +150');
    expect(parts[1]?.buttons).toEqual([
      {
        text: '🚀 Открыть веб-приложение',
        url: 'https://app.example.test/',
        kind: 'web_app',
      },
      {
        text: '📝 Зарегистрироваться в Leader-ID',
        url: 'https://leader-id.ru/events/606467',
        kind: 'url',
      },
    ]);
    expect(parts[2]?.buttons).toEqual([
      {
        text: '💬 Вступить в чат Catalyst',
        url: 'https://t.me/+RUMOR_k8dcAwMmNi',
        kind: 'url',
      },
    ]);
  });

  it('builds the approved opening-day reminder', () => {
    expect(CATALYST_OPENING_REMINDER_BROADCAST_ID).toBe('catalyst-opening-reminder-2026-09-04-v1');
    expect(catalystOpeningReminderBroadcastParts()).toEqual([
      {
        id: 'reminder',
        message: [
          'Друзья, ждём вас сегодня на открытии Catalyst! 🚀',
          '',
          'Будем знакомиться, играть в стартап-квиз, общаться с экспертами и искать людей, с которыми можно делать проект вместе. Расскажем, как будет устроен Catalyst и система баллов.',
          '',
          'И, конечно, просто хорошо проведём время: будет еда, чай и кофе, а ещё куча призов. Да, Oreo и дошики тоже разыгрываем 👀',
          '',
          '⏰ Сегодня в 16:20',
          '📍 Библиотека КПА',
          '',
          'До встречи! 💙',
        ].join('\n'),
      },
    ]);
  });
});
