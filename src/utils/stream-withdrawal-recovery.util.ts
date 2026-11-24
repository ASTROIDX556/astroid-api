export interface WithdrawalErrorClassification {
  retryable: boolean;
  status: number;
}

export function classifyStreamWithdrawalError(
  code: string,
): WithdrawalErrorClassification {
  if (code === 'RPC_TIMEOUT' || code === 'RATE_LIMITED') {
    return { retryable: true, status: 503 };
  }
  return { retryable: false, status: 400 };
}
