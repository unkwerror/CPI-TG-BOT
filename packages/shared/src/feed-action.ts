export interface FeedActionSelection {
  ctaUrl?: string | null;
  eventId?: string | null;
  productId?: string | null;
}

export function isSafeFeedActionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

export function feedActionValidationError(input: FeedActionSelection): string | null {
  const ctaUrl = input.ctaUrl?.trim() || null;
  const actions = [ctaUrl, input.eventId, input.productId].filter(Boolean);
  if (actions.length > 1) {
    return 'Выберите одно действие: внешнюю ссылку, мероприятие или товар';
  }
  if (ctaUrl && !isSafeFeedActionUrl(ctaUrl)) {
    return 'CTA должна быть полной http(s)-ссылкой без логина и пароля';
  }
  return null;
}
