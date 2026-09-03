import {
  AuthDateInvalidError,
  SignatureMissingError,
  parse,
  validate,
} from '@tma.js/init-data-node';
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

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  options?: { now?: Date; maxAgeSeconds?: number },
): VerifiedTelegramData {
  const parameters = new URLSearchParams(initData);
  if (!parameters.get('hash')) {
    throw new AppError('TELEGRAM_SIGNATURE_MISSING', 'В данных Telegram отсутствует подпись', 401);
  }
  try {
    // The library owns Telegram's HMAC construction and constant-time signature comparison.
    // Expiration is deliberately disabled here and checked below against the injected clock so
    // tests, backfills and incident replay remain deterministic.
    validate(initData, botToken, { expiresIn: 0 });
  } catch (error) {
    if (error instanceof SignatureMissingError) {
      throw new AppError(
        'TELEGRAM_SIGNATURE_MISSING',
        'В данных Telegram отсутствует подпись',
        401,
      );
    }
    if (error instanceof AuthDateInvalidError) {
      throw new AppError(
        'TELEGRAM_AUTH_DATE_INVALID',
        'Некорректная дата авторизации Telegram',
        401,
      );
    }
    throw new AppError('TELEGRAM_SIGNATURE_INVALID', 'Подпись Telegram не прошла проверку', 401);
  }

  // `signature` was added for third-party Ed25519 validation and older Telegram WebApp clients
  // legitimately omit it. `validate` above has already authenticated the original payload by
  // hash, so an empty parser-only value preserves backwards compatibility without weakening it.
  const parserParameters = new URLSearchParams(parameters);
  if (!parserParameters.has('signature')) parserParameters.set('signature', '');
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(parserParameters);
  } catch {
    if (!parameters.get('user')) {
      throw new AppError('TELEGRAM_USER_MISSING', 'Telegram не передал данные пользователя', 401);
    }
    throw new AppError('TELEGRAM_USER_INVALID', 'Некорректные данные пользователя Telegram', 401);
  }
  const authDate = parsed.auth_date;
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

  if (!parsed.user) {
    throw new AppError('TELEGRAM_USER_MISSING', 'Telegram не передал данные пользователя', 401);
  }

  let parsedUser: z.infer<typeof telegramUserSchema>;
  try {
    parsedUser = telegramUserSchema.parse(parsed.user);
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
    ...(parsed.query_id ? { queryId: parsed.query_id } : {}),
    ...(parsed.start_param ? { startParam: parsed.start_param } : {}),
  };
}
