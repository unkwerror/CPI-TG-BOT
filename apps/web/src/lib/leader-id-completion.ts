export type LeaderIdCompletionResult = 'linked' | 'error';

/** URL query is public input: only one exact success value may render the success state. */
export function resolveLeaderIdCompletionResult(
  value: string | string[] | undefined,
): LeaderIdCompletionResult {
  return value === 'linked' ? 'linked' : 'error';
}
