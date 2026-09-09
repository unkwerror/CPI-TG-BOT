import type { AdminEventPeriod, AdminEventSort, EventStatus } from '@cpi/shared';

export interface AdminEventFilters {
  q: string;
  status: EventStatus | '';
  period: AdminEventPeriod;
  sort: AdminEventSort;
  page: number;
}

export const defaultAdminEventFilters: AdminEventFilters = {
  q: '',
  status: '',
  period: 'all',
  sort: 'starts_desc',
  page: 1,
};

export function adminEventListPath(filters: AdminEventFilters): string {
  const query = new URLSearchParams({
    page: String(filters.page),
    limit: '20',
    sort: filters.sort,
    period: filters.period,
  });
  if (filters.q.trim()) query.set('q', filters.q.trim());
  if (filters.status) query.set('status', filters.status);
  return `/admin/events?${query}`;
}
