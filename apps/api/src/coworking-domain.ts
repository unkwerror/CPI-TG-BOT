import { z } from 'zod';
import { AppError } from '@cpi/shared';

export const coworkingStatuses = ['pending', 'confirmed', 'rejected', 'cancelled'] as const;
export const bookingCreateSchema = z
  .object({
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    attendees: z.number().int().min(1).max(20),
    purpose: z.string().trim().min(3).max(1000),
  })
  .strict();

export function validateBookingWindow(startsAt: Date, endsAt: Date, now = new Date()): void {
  const duration = endsAt.getTime() - startsAt.getTime();
  if (startsAt <= now || startsAt.getTime() > now.getTime() + 90 * 86400000) {
    throw new AppError('BOOKING_DATE_INVALID', 'Выберите будущую дату в пределах 90 дней', 400);
  }
  if (duration < 30 * 60000 || duration > 8 * 3600000) {
    throw new AppError(
      'BOOKING_DURATION_INVALID',
      'Продолжительность — от 30 минут до 8 часов',
      400,
    );
  }
}

export function canChangeBookingStatus(from: string, to: string): boolean {
  if (from === to) return true;
  return (
    (from === 'pending' && ['confirmed', 'rejected', 'cancelled'].includes(to)) ||
    (from === 'confirmed' && to === 'cancelled')
  );
}
