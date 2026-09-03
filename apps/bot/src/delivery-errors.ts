export function isPermanentTelegramRecipientError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'error_code' in error && error.error_code === 403
  );
}
