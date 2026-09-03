import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyMaxSharedContact } from './max-contact';

const token = 'max-test-token-that-is-long-enough';
const userId = '67890';
const now = new Date('2026-08-25T07:00:00.000Z');

function contact(phone = '+7 999 123-45-67') {
  const authDate = String(Math.floor(now.getTime() / 1_000));
  const normalizedPhone = phone.replace(/\D/gu, '');
  const checkString = [`authDate=${authDate}`, `phone=${normalizedPhone}`, `userId=${userId}`].join(
    '\n',
  );
  return {
    phone,
    authDate,
    hash: createHmac('sha256', token).update(checkString).digest('hex'),
  };
}

describe('verifyMaxSharedContact', () => {
  it('verifies and normalizes a phone signed by MAX', () => {
    expect(verifyMaxSharedContact(contact(), userId, token, { now })).toBe('+79991234567');
  });

  it('rejects a changed phone and an expired signature', () => {
    const signed = contact();
    expect(() =>
      verifyMaxSharedContact({ ...signed, phone: '+7 999 000-00-00' }, userId, token, {
        now,
      }),
    ).toThrow(/подтвердить/u);
    expect(() =>
      verifyMaxSharedContact(signed, userId, token, {
        now: new Date(now.getTime() + 3_601_000),
      }),
    ).toThrow(/устарело/u);
  });
});
