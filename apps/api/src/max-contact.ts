import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '@cpi/shared';

export interface MaxSharedContact {
  phone: string;
  authDate: string;
  hash: string;
}

function safeEqualHex(received: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/iu.test(received)) return false;
  const left = Buffer.from(received.toLowerCase(), 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyMaxSharedContact(
  input: MaxSharedContact,
  externalUserId: string,
  botToken: string,
  options: { now?: Date; maxAgeSeconds?: number } = {},
): string {
  if (!/^\d{1,20}$/u.test(externalUserId)) {
    throw new AppError('MAX_CONTACT_USER_INVALID', 'Некорректный MAX ID', 400);
  }
  const phone = input.phone.replace(/\D/gu, '').slice(0, 32);
  if (phone.length < 7 || phone.length > 15) {
    throw new AppError('MAX_CONTACT_PHONE_INVALID', 'MAX передал некорректный номер телефона', 400);
  }
  if (!/^\d{10,16}$/u.test(input.authDate)) {
    throw new AppError(
      'MAX_CONTACT_DATE_INVALID',
      'MAX передал некорректное время подтверждения',
      400,
    );
  }
  const rawTimestamp = Number(input.authDate);
  const timestampMs = rawTimestamp >= 1_000_000_000_000 ? rawTimestamp : rawTimestamp * 1_000;
  const nowMs = (options.now ?? new Date()).getTime();
  const maxAgeMs = (options.maxAgeSeconds ?? 3_600) * 1_000;
  if (
    !Number.isSafeInteger(timestampMs) ||
    timestampMs > nowMs + 60_000 ||
    nowMs - timestampMs > maxAgeMs
  ) {
    throw new AppError(
      'MAX_CONTACT_EXPIRED',
      'Подтверждение номера устарело — запросите номер ещё раз',
      401,
    );
  }
  const checkString = [
    `authDate=${input.authDate}`,
    `phone=${phone}`,
    `userId=${externalUserId}`,
  ].join('\n');
  const expected = createHmac('sha256', botToken).update(checkString).digest('hex');
  if (!safeEqualHex(input.hash, expected)) {
    throw new AppError(
      'MAX_CONTACT_SIGNATURE_INVALID',
      'Не удалось подтвердить номер через MAX',
      401,
    );
  }
  return `+${phone}`;
}
