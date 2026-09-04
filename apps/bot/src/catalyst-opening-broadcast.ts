export interface BroadcastButton {
  text: string;
  url: string;
  kind: 'web_app' | 'url';
}

export interface CatalystOpeningBroadcastPart {
  id: 'announcement' | 'registration' | 'chat' | 'reminder';
  message: string;
  buttons?: BroadcastButton[];
}

export const CATALYST_OPENING_BROADCAST_ID = 'catalyst-opening-2026-09-03-v1';
export const CATALYST_OPENING_REMINDER_BROADCAST_ID = 'catalyst-opening-reminder-2026-09-04-v1';

const leaderIdEventUrl = 'https://leader-id.ru/events/606467';
const catalystChatUrl = 'https://t.me/+RUMOR_k8dcAwMmNi';

export function catalystOpeningBroadcastParts(webAppUrl: string): CatalystOpeningBroadcastPart[] {
  return [
    {
      id: 'announcement',
      message: [
        'Уже завтра открываем новый сезон Catalyst 🚀',
        '',
        'На открытии главное — познакомиться и хорошо провести время перед насыщенными учебными днями. Сыграем в стартап-квиз, пообщаемся друг с другом и экспертами, а заодно расскажем, как будет устроен Catalyst и система баллов.',
        '',
        'Мы всё подготовили: будет еда, чай и кофе, а ещё много призов, которые разыграем среди участников 👀 Среди них — Oreo и дошики. А победители квиза заберут ещё и футболки!',
        '',
        '🗓 4 сентября, 16:20',
        '📍 Библиотека КПА',
      ].join('\n'),
    },
    {
      id: 'registration',
      message: [
        'Чтобы участвовать в активностях и получать баллы, заранее зарегистрируйтесь на открытие.',
        '',
        'Сделать это можно прямо через наше веб-приложение:',
        '',
        '1. Нажмите кнопку «Открыть веб-приложение».',
        '2. На главной странице найдите раздел «Leader-ID + Catalyst».',
        '3. Введите номер своего Leader-ID и подтвердите подключение.',
        '4. Нажмите «Подключиться к Catalyst и получить +150».',
        '',
        'Если аккаунта Leader-ID ещё нет, приложение поможет открыть регистрацию. Подтвердите телефон, заполните профиль, вернитесь в приложение и подключите созданный аккаунт.',
        '',
        'После подключения веб-приложение автоматически отправит заявки на доступные мероприятия Catalyst. Также можно зарегистрироваться напрямую на сайте Leader-ID.',
      ].join('\n'),
      buttons: [
        { text: '🚀 Открыть веб-приложение', url: webAppUrl, kind: 'web_app' },
        { text: '📝 Зарегистрироваться в Leader-ID', url: leaderIdEventUrl, kind: 'url' },
      ],
    },
    {
      id: 'chat',
      message: [
        'И заглядывайте в чат Catalyst 👋',
        '',
        'Там уже выложили фотографии с Science Picnic — ищите себя 📸 А дальше именно в чате будут материалы курса, важные объявления, задания и общение с другими участниками.',
      ].join('\n'),
      buttons: [{ text: '💬 Вступить в чат Catalyst', url: catalystChatUrl, kind: 'url' }],
    },
  ];
}

export function catalystOpeningReminderBroadcastParts(): CatalystOpeningBroadcastPart[] {
  return [
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
  ];
}
