import { describe, expect, it } from 'vitest';
import { adminEventListPath, defaultAdminEventFilters } from './admin-events';

describe('admin event list request', () => {
  it('always requests numbered pages rather than filtering only the first 100 records', () => {
    const url = new URL(
      adminEventListPath({ ...defaultAdminEventFilters, page: 7 }),
      'https://example.test',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: '7',
      limit: '20',
      sort: 'starts_desc',
      period: 'all',
    });
  });
  it('sends status and period together and safely encodes literal search text', () => {
    const filters = {
      ...defaultAdminEventFilters,
      q: '  НГУ & A_20%  ',
      status: 'draft' as const,
      period: 'upcoming' as const,
    };
    const url = new URL(adminEventListPath(filters), 'https://example.test');
    expect(url.searchParams.get('q')).toBe('НГУ & A_20%');
    expect(url.searchParams.get('status')).toBe('draft');
    expect(url.searchParams.get('period')).toBe('upcoming');
    expect(filters.q).toBe('  НГУ & A_20%  ');
  });
});
