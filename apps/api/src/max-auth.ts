import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@cpi/shared';

const maxUserSchema = z.object({
  id: z.number().int().positive().safe(),
  first_name: z.string().max(200),
  last_name: z.string().max(200).nullish(),
  username: z.string().max(100).nullish(),
  language_code: z.string().max(20).nullish(),
  photo_url: z.url().max(2_000).nullish(),
});

export interface VerifiedMaxData {
  user: {
    id: bigint;
    firstName: string;
    lastName?: string;
    username?: string;
    languageCode?: string;
    photoUrl?: string;
  };
  authDate: Date;
  queryId?: string;
  startParam?: string;
}

function exactlyOne(parameters: URLSearchParams, key: string): string | null {
  const values = parameters.getAll(key);
  return values.length === 1 ? (values[0] ?? null) : null;
}

export function verifyMaxInitData(
  initData: string,
  botToken: string,
  options?: { now?: Date; maxAgeSeconds?: number },
): VerifiedMaxData {
  const parameters = new URLSearchParams(initData);
  const suppliedHash = exactlyOne(parameters, 'hash');
  if (!suppliedHash || !/^[0-9a-f]{64}$/iu.test(suppliedHash)) {
    throw new AppError('MAX_SIGNATURE_MISSING', 'В данных MAX отсутствует корректная подпись', 401);
  }
  if ([...parameters.keys()].some((key) => parameters.getAll(key).length !== 1)) {
    throw new AppError('MAX_INIT_DATA_INVALID', 'MAX передал неоднозначные параметры входа', 401);
  }

  const launchParameters = [...parameters.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = createHmac('sha256', secret).update(launchParameters).digest();
  const receivedHash = Buffer.from(suppliedHash, 'hex');
  if (receivedHash.length !== expectedHash.length || !timingSafeEqual(receivedHash, expectedHash)) {
    throw new AppError('MAX_SIGNATURE_INVALID', 'Подпись MAX не прошла проверку', 401);
  }

  const rawAuthDate = exactlyOne(parameters, 'auth_date');
  if (!rawAuthDate || !/^\d+$/u.test(rawAuthDate)) {
    throw new AppError('MAX_AUTH_DATE_INVALID', 'Некорректная дата авторизации MAX', 401);
  }
  const authDate = new Date(Number(rawAuthDate) * 1_000);
  const now = options?.now ?? new Date();
  const ageSeconds = (now.getTime() - authDate.getTime()) / 1_000;
  const maxAgeSeconds = options?.maxAgeSeconds ?? 86_400;
  if (!Number.isFinite(authDate.getTime()) || ageSeconds < -60) {
    throw new AppError('MAX_AUTH_DATE_INVALID', 'Дата авторизации MAX находится в будущем', 401);
  }
  if (ageSeconds > maxAgeSeconds) {
    throw new AppError('MAX_AUTH_EXPIRED', 'Авторизация MAX устарела', 401);
  }

  const rawUser = exactlyOne(parameters, 'user');
  if (!rawUser) {
    throw new AppError('MAX_USER_MISSING', 'MAX не передал данные пользователя', 401);
  }
  let user: z.infer<typeof maxUserSchema>;
  try {
    user = maxUserSchema.parse(JSON.parse(rawUser));
  } catch {
    throw new AppError('MAX_USER_INVALID', 'Некорректные данные пользователя MAX', 401);
  }

  const queryId = exactlyOne(parameters, 'query_id');
  const startParam = exactlyOne(parameters, 'start_param');
  return {
    user: {
      id: BigInt(user.id),
      firstName: user.first_name,
      ...(user.last_name ? { lastName: user.last_name } : {}),
      ...(user.username ? { username: user.username } : {}),
      ...(user.language_code ? { languageCode: user.language_code } : {}),
      ...(user.photo_url ? { photoUrl: user.photo_url } : {}),
    },
    authDate,
    ...(queryId ? { queryId } : {}),
    ...(startParam ? { startParam } : {}),
  };
}
