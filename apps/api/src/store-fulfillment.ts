import { AppError } from '@cpi/shared';

// Team funding is verified by the organisers. Never debit a personal wallet for this lot.
export function assertPersonalCheckoutAllowed(product: { slug: string }): void {
  if (product.slug === 'catalyst-startup-lynch-pass') {
    throw new AppError(
      'TEAM_FUNDING_REQUIRED',
      'Проходка оплачивается только командными баллами. Согласуйте участие и оплату с организаторами Catalyst.',
      409,
    );
  }
}
