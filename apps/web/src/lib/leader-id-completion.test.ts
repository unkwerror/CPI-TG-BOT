import { describe, expect, it } from 'vitest';
import { resolveLeaderIdCompletionResult } from './leader-id-completion';

describe('Leader-ID completion result', () => {
  it('accepts only the exact success marker', () => {
    expect(resolveLeaderIdCompletionResult('linked')).toBe('linked');
  });

  it('fails closed for missing, repeated and attacker-controlled query values', () => {
    for (const value of [
      undefined,
      'error',
      'LINKED',
      '<script>alert(1)</script>',
      ['linked'],
      ['linked', 'error'],
    ]) {
      expect(resolveLeaderIdCompletionResult(value)).toBe('error');
    }
  });
});
