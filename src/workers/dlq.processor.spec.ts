import { describe, expect, it } from 'vitest';
import { isTerminalJobFailure } from './dlq.processor';

describe('isTerminalJobFailure', () => {
  it('returns false when retries remain', () => {
    expect(
      isTerminalJobFailure(
        { attemptsMade: 2, opts: { attempts: 5 }, stacktrace: [] },
        'HTTP 503',
      ),
    ).toBe(false);
  });

  it('returns true when attempts are exhausted', () => {
    expect(
      isTerminalJobFailure(
        { attemptsMade: 5, opts: { attempts: 5 }, stacktrace: [] },
        'HTTP 500',
      ),
    ).toBe(true);
  });

  it('returns true for unrecoverable failures on the first attempt', () => {
    expect(
      isTerminalJobFailure(
        {
          attemptsMade: 1,
          opts: { attempts: 5 },
          stacktrace: ['UnrecoverableError: HTTP 422'],
        },
        'HTTP 422',
      ),
    ).toBe(true);
  });
});
