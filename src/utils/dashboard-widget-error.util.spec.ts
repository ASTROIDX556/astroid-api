import { describe, expect, it } from 'vitest';
import { deriveDashboardWidgetFallbackState } from './dashboard-widget-error.util';

describe('deriveDashboardWidgetFallbackState (#310)', () => {
  it('captures widget errors and resets state cleanly on retry', () => {
    expect(deriveDashboardWidgetFallbackState(new Error('RPC timeout'))).toEqual({
      hasError: true,
      message: 'RPC timeout',
      canRetry: true,
    });
    expect(deriveDashboardWidgetFallbackState(null)).toEqual({
      hasError: false,
      message: null,
      canRetry: false,
    });
  });
});
