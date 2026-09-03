export function isPermanentTelegramRecipientError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('error_code' in error)) return false;
  if (error.error_code === 403) return true;
  if (
    error.error_code !== 400 ||
    !('description' in error) ||
    typeof error.description !== 'string'
  ) {
    return false;
  }
  return error.description.toLowerCase().includes('chat not found');
}
