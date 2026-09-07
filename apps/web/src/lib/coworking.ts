export type CoworkingStatus = 'pending' | 'confirmed' | 'rejected' | 'cancelled';
export interface CoworkingBooking {
  id: string;
  startsAt: string;
  endsAt: string;
  attendees: number;
  purpose: string;
  status: CoworkingStatus;
  adminNote: string | null;
  createdAt: string;
  user?: {
    id: string;
    fullName: string | null;
    username: string | null;
    phone: string | null;
  };
}
export const bookingStatusLabels: Record<CoworkingStatus, string> = {
  pending: 'На рассмотрении',
  confirmed: 'Подтверждено',
  rejected: 'Отклонено',
  cancelled: 'Отменено',
};
