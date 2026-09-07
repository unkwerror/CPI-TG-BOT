import { describe, expect, it } from 'vitest';
import {
  bookingCreateSchema,
  canChangeBookingStatus,
  validateBookingWindow,
} from './coworking-domain';
describe('coworking requests', () => {
  const now = new Date('2026-09-07T08:00:00Z');
  it('accepts a future request with a Novosibirsk offset', () => {
    const body = bookingCreateSchema.parse({
      startsAt: '2026-09-08T12:00:00+07:00',
      endsAt: '2026-09-08T14:00:00+07:00',
      attendees: 4,
      purpose: ' Встреча команды ',
    });
    expect(body.purpose).toBe('Встреча команды');
    expect(() =>
      validateBookingWindow(new Date(body.startsAt), new Date(body.endsAt), now),
    ).not.toThrow();
    expect(new Date(body.startsAt).toISOString()).toBe('2026-09-08T05:00:00.000Z');
  });
  it.each([
    ['2026-09-06T08:00Z', '2026-09-06T10:00Z'],
    ['2026-12-20T08:00Z', '2026-12-20T10:00Z'],
    ['2026-09-08T10:00Z', '2026-09-08T08:00Z'],
    ['2026-09-08T08:00Z', '2026-09-08T08:15Z'],
    ['2026-09-08T08:00Z', '2026-09-08T17:00Z'],
  ])('rejects invalid booking window %s', (start, end) => {
    expect(() => validateBookingWindow(new Date(start), new Date(end), now)).toThrow();
  });
  it('rejects user-controlled status, user IDs and excess attendees', () => {
    const body = {
      startsAt: '2026-09-08T08:00:00Z',
      endsAt: '2026-09-08T10:00:00Z',
      attendees: 1,
      purpose: 'Работа над проектом',
    };
    expect(bookingCreateSchema.safeParse({ ...body, status: 'confirmed' }).success).toBe(false);
    expect(bookingCreateSchema.safeParse({ ...body, userId: 'victim' }).success).toBe(false);
    expect(bookingCreateSchema.safeParse({ ...body, attendees: 21 }).success).toBe(false);
  });
  it('allows review and cancellation but never reopens closed requests', () => {
    expect(canChangeBookingStatus('pending', 'confirmed')).toBe(true);
    expect(canChangeBookingStatus('pending', 'rejected')).toBe(true);
    expect(canChangeBookingStatus('confirmed', 'cancelled')).toBe(true);
    expect(canChangeBookingStatus('rejected', 'confirmed')).toBe(false);
    expect(canChangeBookingStatus('cancelled', 'confirmed')).toBe(false);
    expect(canChangeBookingStatus('confirmed', 'pending')).toBe(false);
    expect(canChangeBookingStatus('cancelled', 'cancelled')).toBe(true);
  });
});
