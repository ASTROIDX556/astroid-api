export interface MappedContractRevert {
  code: string;
  userMessage: string;
  retryable: boolean;
  rawReason: string;
}

const KNOWN_REVERT_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  code: string;
  userMessage: string;
  retryable: boolean;
}> = [
  {
    pattern: /insufficient[_\s-]?balance|underfunded/i,
    code: 'CONTRACT_INSUFFICIENT_BALANCE',
    userMessage: 'Account balance is insufficient to complete the contract transfer',
    retryable: false,
  },
  {
    pattern: /unauthorized|caller[_\s-]?not[_\s-]?owner|access[_\s-]?denied/i,
    code: 'CONTRACT_UNAUTHORIZED',
    userMessage: 'Caller is not authorized to invoke this contract method',
    retryable: false,
  },
  {
    pattern: /deadline[_\s-]?expired|expired/i,
    code: 'CONTRACT_DEADLINE_EXPIRED',
    userMessage: 'Contract execution deadline has expired',
    retryable: false,
  },
  {
    pattern: /budget[_\s-]?exceeded|resource[_\s-]?limit/i,
    code: 'CONTRACT_RESOURCE_LIMIT',
    userMessage: 'Contract invocation exceeded ledger resource limits',
    retryable: true,
  },
];

export function mapContractRevertReason(rawError: unknown): MappedContractRevert {
  const rawReason =
    rawError instanceof Error
      ? rawError.message
      : typeof rawError === 'string'
        ? rawError
        : 'Unknown contract revert';

  for (const entry of KNOWN_REVERT_PATTERNS) {
    if (entry.pattern.test(rawReason)) {
      return {
        code: entry.code,
        userMessage: entry.userMessage,
        retryable: entry.retryable,
        rawReason,
      };
    }
  }

  return {
    code: 'CONTRACT_EXECUTION_REVERTED',
    userMessage: 'Smart contract execution reverted',
    retryable: false,
    rawReason,
  };
}
