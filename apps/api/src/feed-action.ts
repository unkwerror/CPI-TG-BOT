import {
  AppError,
  feedActionValidationError,
  isSafeFeedActionUrl,
  type FeedActionSelection,
} from '@cpi/shared';

export { isSafeFeedActionUrl };

export function assertFeedActionSelection(input: FeedActionSelection): void {
  const error = feedActionValidationError(input);
  if (!error) return;
  throw new AppError(
    error.startsWith('Выберите') ? 'FEED_ACTION_CONFLICT' : 'FEED_ACTION_URL_INVALID',
    error,
    400,
  );
}
