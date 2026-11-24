export interface DashboardWidgetFallbackState {
  hasError: boolean;
  message: string | null;
  canRetry: boolean;
}

export function deriveDashboardWidgetFallbackState(
  err: Error | null,
): DashboardWidgetFallbackState {
  return {
    hasError: err !== null,
    message: err ? err.message : null,
    canRetry: err !== null,
  };
}
