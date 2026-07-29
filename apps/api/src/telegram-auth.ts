import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@cpi/shared';

const telegramUserSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  first_name: z.string().max(200),
  last_name: z.string().max(200).optional(),
  username: z.string().max(100).optional(),
  language_code: z.string().max(20).optional(),
  photo_url: z.url().max(2_000).optional(),
  allows_write_to_pm: z.boolean().optional(),
});

export interface VerifiedTelegramData {
  user: {
    id: bigint;
    firstName: string;
    lastName?: string;
    username?: string;
    languageCode?: string;
    photoUrl?: string;
    allowsWriteToPm?: boolean;
  };
  authDate: Date;
  queryId?: string;
  startParam?: string;
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  options?: { now?: Date; maxAgeSeconds?: number },
): VerifiedTelegramData {
  const parameters = new URLSearchParams(initData);
  const receivedHash = parameters.get('hash');
  if (!receivedHash) {
    throw new AppError('TELEGRAM_SIGNATURE_MISSING', 'В данных Telegram отсутствует подпись', 401);
  }

  parameters.delete('hash');
  const dataCheckString = [...parameters.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (!constantTimeHexEqual(calculatedHash, receivedHash)) {
    throw new AppError('TELEGRAM_SIGNATURE_INVALID', 'Подпись Telegram не прошла проверку', 401);
  }

  const authDateSeconds = Number(parameters.get('auth_date'));
  if (!Number.isSafeInteger(authDateSeconds) || authDateSeconds <= 0) {
    throw new AppError('TELEGRAM_AUTH_DATE_INVALID', 'Некорректная дата авторизации Telegram', 401);
  }
  const authDate = new Date(authDateSeconds * 1000);
  const now = options?.now ?? new Date();
  const maxAgeSeconds = options?.maxAgeSeconds ?? 86_400;
  const ageSeconds = (now.getTime() - authDate.getTime()) / 1000;
  if (ageSeconds > maxAgeSeconds) {
    throw new AppError('TELEGRAM_AUTH_EXPIRED', 'Авторизация Telegram устарела', 401);
  }
  if (ageSeconds < -60) {
    throw new AppError(
      'TELEGRAM_AUTH_DATE_INVALID',
      'Дата авторизации Telegram находится в будущем',
      401,
    );
  }

  const rawUser = parameters.get('user');
  if (!rawUser) {
    throw new AppError('TELEGRAM_USER_MISSING', 'Telegram не передал данные пользователя', 401);
  }

  let parsedUser: z.infer<typeof telegramUserSchema>;
  try {
    parsedUser = telegramUserSchema.parse(JSON.parse(rawUser));
  } catch {
    throw new AppError('TELEGRAM_USER_INVALID', 'Некорректные данные пользователя Telegram', 401);
  }

  return {
    user: {
      id: BigInt(parsedUser.id),
      firstName: parsedUser.first_name,
      ...(parsedUser.last_name ? { lastName: parsedUser.last_name } : {}),
      ...(parsedUser.username ? { username: parsedUser.username } : {}),
      ...(parsedUser.language_code ? { languageCode: parsedUser.language_code } : {}),
      ...(parsedUser.photo_url ? { photoUrl: parsedUser.photo_url } : {}),
      ...(parsedUser.allows_write_to_pm === undefined
        ? {}
        : { allowsWriteToPm: parsedUser.allows_write_to_pm }),
    },
    authDate,
    ...(parameters.get('query_id') ? { queryId: parameters.get('query_id')! } : {}),
    ...(parameters.get('start_param') ? { startParam: parameters.get('start_param')! } : {}),
  };
}
