import { describe, expect, it } from 'vitest';
import {
  decodeContractRevert,
  isRecognisedContractRevert,
  listContractErrorAbis,
  registerContractErrorAbi,
  toContractRevertException,
} from './contract-revert.decoder';
import {
  ConflictException,
  ContractPanicException,
  ContractRevertedException,
  DomainException,
  ForbiddenException,
  InsufficientFundsException,
} from './domain.exception';
import { ErrorCode } from '../constants/error-codes';

function hexWord(value: bigint | number): string {
  return BigInt(value).toString(16).padStart(64, '0');
}

/** ABI-encodes a canonical `Error(string)` revert payload. */
function encodeErrorString(message: string): string {
  const body = Buffer.from(message, 'utf8');
  const padding = Buffer.alloc((32 - (body.length % 32)) % 32);
  return `0x08c379a0${hexWord(0x20)}${hexWord(body.length)}${Buffer.concat([body, padding]).toString('hex')}`;
}

/** ABI-encodes a canonical `Panic(uint256)` revert payload. */
function encodePanic(code: number): string {
  return `0x4e487b71${hexWord(code)}`;
}

/** ABI-encodes a custom error selector plus static words. */
function encodeCustom(selector: string, words: Array<bigint | number>): string {
  return `0x${selector.replace(/^0x/, '')}${words.map(hexWord).join('')}`;
}

function expectDomainError(error: unknown): DomainException {
  expect(error).toBeInstanceOf(DomainException);
  return error as DomainException;
}

describe('decodeContractRevert', () => {
  it('decodes a canonical Error(string) revert payload', () => {
    const decoded = decodeContractRevert(encodeErrorString('insufficient balance for transfer'));

    expect(decoded.kind).toBe('message');
    expect(decoded.message).toBe('insufficient balance for transfer');
    expect(decoded.selector).toBe('0x08c379a0');
    expect(decoded.signature).toBe('Error(string)');
    expect(decoded.raw.format).toBe('hex');
  });

  it('decodes hex payloads without a 0x prefix', () => {
    const decoded = decodeContractRevert(encodeErrorString('deadline expired').slice(2));

    expect(decoded.message).toBe('deadline expired');
    expect(decoded.signature).toBe('Error(string)');
  });

  it('decodes base64 encoded revert data', () => {
    const base64 = Buffer.from(encodeErrorString('paused').slice(2), 'hex').toString('base64');
    const decoded = decodeContractRevert(base64);

    expect(decoded.message).toBe('paused');
    expect(decoded.raw.format).toBe('base64');
    expect(decoded.raw.data).toBe(base64);
  });

  it('decodes binary revert data and preserves it as hex', () => {
    const bytes = Buffer.from(encodeErrorString('recipient is blacklisted').slice(2), 'hex');
    const decoded = decodeContractRevert(new Uint8Array(bytes));

    expect(decoded.message).toBe('recipient is blacklisted');
    expect(decoded.raw).toEqual({ format: 'bytes', data: bytes.toString('hex') });
  });

  it('falls back to a generic message for a truncated Error(string) payload', () => {
    const decoded = decodeContractRevert('0x08c379a0');

    expect(decoded.kind).toBe('message');
    expect(decoded.message).toBe('Contract reverted without a reason');
  });

  it('decodes solidity panics and their reason code', () => {
    const decoded = decodeContractRevert(encodePanic(0x11));

    expect(decoded.kind).toBe('panic');
    expect(decoded.panicCode).toBe(0x11);
    expect(decoded.message).toBe('Contract panicked: arithmetic overflow or underflow');
  });

  it('describes an unknown panic code without throwing', () => {
    const decoded = decodeContractRevert(encodePanic(0x99));

    expect(decoded.kind).toBe('panic');
    expect(decoded.message).toContain('0x99');
  });

  it('decodes registered custom contract errors with their arguments', () => {
    registerContractErrorAbi({
      selector: '0x12345678',
      signature: 'InsufficientBalance(address,uint256)',
      description: 'Insufficient balance for this transfer',
    });

    const selector = '0x12345678';
    const address = '0x00000000000000000000000000000000000000ff';
    const decoded = decodeContractRevert(encodeCustom(selector, [BigInt(address), 5_000_000n]));

    expect(decoded.kind).toBe('custom');
    expect(decoded.signature).toBe('InsufficientBalance(address,uint256)');
    expect(decoded.args).toEqual([address, '5000000']);
    expect(decoded.message).toContain('Insufficient balance');
    expect(listContractErrorAbis().some((abi) => abi.selector === selector)).toBe(true);
  });

  it('rejects selectors that are not four bytes of hex', () => {
    expect(() =>
      registerContractErrorAbi({ selector: '0x1234', signature: 'Bad()', description: 'Bad' }),
    ).toThrow(TypeError);
  });

  it('decodes a Soroban contract error reported as a host error', () => {
    const decoded = decodeContractRevert({
      code: 'HOST_ERROR',
      message: 'HostError: Error(Contract, #4)',
      contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    });

    expect(decoded.kind).toBe('contract');
    expect(decoded.errorCode).toBe(4);
    expect(decoded.hostErrorType).toBe('Contract');
    expect(decoded.contractId).toBe('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    expect(decoded.raw.data).toContain('HostError: Error(Contract, #4)');
  });

  it('decodes host errors with a symbolic code', () => {
    const decoded = decodeContractRevert('Error(Auth, InvalidAction)');

    expect(decoded.kind).toBe('contract');
    expect(decoded.hostErrorType).toBe('Auth');
    expect(decoded.errorLabel).toBe('InvalidAction');
    expect(decoded.errorCode).toBeUndefined();
  });

  it('unwraps nested error objects and keeps the contract id', () => {
    const decoded = decodeContractRevert({
      contractId: 'CABC',
      error: { code: 'txFailed', message: 'HostError: Error(Contract, #7)' },
    });

    expect(decoded.kind).toBe('contract');
    expect(decoded.errorCode).toBe(7);
    expect(decoded.contractId).toBe('CABC');
  });

  it('decodes raw revert data carried on a thrown Error', () => {
    const error = Object.assign(new Error('transaction failed'), {
      revertData: encodeErrorString('insufficient allowance'),
    });

    const decoded = decodeContractRevert(error);

    expect(decoded.kind).toBe('message');
    expect(decoded.message).toBe('insufficient allowance');
  });

  it('preserves unrecognised selectors and raw data instead of throwing', () => {
    const decoded = decodeContractRevert('0xdeadbeef00');

    expect(decoded.kind).toBe('unknown');
    expect(decoded.selector).toBe('0xdeadbeef');
    expect(decoded.message).toContain('Unrecognised contract revert');
    expect(decoded.raw).toEqual({ format: 'hex', data: '0xdeadbeef00' });
    expect(isRecognisedContractRevert(decoded)).toBe(false);
  });

  it('degrades gracefully for malformed and empty inputs', () => {
    for (const input of [null, undefined, '', '0x12', 42, [], {}]) {
      const decoded = decodeContractRevert(input);
      expect(decoded.kind).toBe('unknown');
      expect(decoded.message.length).toBeGreaterThan(0);
      expect(decoded.raw.data).toBeTypeOf('string');
    }
  });

  it('keeps a readable raw payload for circular objects', () => {
    const circular: Record<string, unknown> = { contractId: 'CABC' };
    circular.self = circular;

    const decoded = decodeContractRevert(circular);

    expect(decoded.kind).toBe('unknown');
    expect(decoded.raw.data).toContain('CABC');
  });
});

describe('toContractRevertException', () => {
  it('maps insufficient balance reverts onto InsufficientFundsException', () => {
    const decoded = decodeContractRevert('insufficient balance for transfer');
    const error = expectDomainError(toContractRevertException(decoded));

    expect(error).toBeInstanceOf(InsufficientFundsException);
    expect(error.code).toBe(ErrorCode.INSUFFICIENT_FUNDS);
    expect(error.getStatus()).toBe(422);
    expect(error.details).toEqual({ contractError: decoded });
  });

  it('maps authorisation reverts onto ForbiddenException', () => {
    const decoded = decodeContractRevert('Error(Auth, InvalidAction)');
    const error = expectDomainError(toContractRevertException(decoded));

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.code).toBe(ErrorCode.FORBIDDEN);
    expect(error.details).toEqual({ contractError: decoded });
  });

  it('maps duplicate-state reverts onto ConflictException', () => {
    const decoded = decodeContractRevert('contract already initialized');
    const error = expectDomainError(toContractRevertException(decoded));

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.code).toBe(ErrorCode.CONFLICT);
  });

  it('maps panics onto ContractPanicException', () => {
    const error = expectDomainError(
      toContractRevertException(decodeContractRevert(encodePanic(0x12))),
    );

    expect(error).toBeInstanceOf(ContractPanicException);
    expect(error.code).toBe(ErrorCode.CONTRACT_PANIC);
    expect(error.message).toContain('division or modulo by zero');
  });

  it('falls back to ContractRevertedException with the decoded payload intact', () => {
    const decoded = decodeContractRevert('0xdeadbeef00');
    const error = expectDomainError(toContractRevertException(decoded));

    expect(error).toBeInstanceOf(ContractRevertedException);
    expect(error.code).toBe(ErrorCode.CONTRACT_REVERTED);
    expect(error.getStatus()).toBe(422);
    expect(error.details).toEqual({ contractError: decoded });
  });

  it('includes the Soroban contract error number and raw host error in the message/details', () => {
    const decoded = decodeContractRevert({
      code: 'HOST_ERROR',
      message: 'HostError: Error(Contract, #4)',
    });
    const error = expectDomainError(toContractRevertException(decoded));

    expect(error).toBeInstanceOf(ContractRevertedException);
    expect(error.message).toContain('#4');
    expect(
      (error.details as { contractError: { raw: { data: string } } }).contractError.raw.data,
    ).toContain('HostError: Error(Contract, #4)');
  });
});
