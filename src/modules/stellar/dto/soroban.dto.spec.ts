import { ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { SorobanValidationPipe } from '../../../common/pipes/soroban-validation.pipe';
import { ZodValidationException } from '../../../common/pipes/zod-validation.pipe';
import {
  sorobanInvocationSchema,
  sorobanTransactionSchema,
} from './soroban.dto';

const VALID_CONTRACT_ID = 'CBRW63TUOJQWG5DBMRSHEMJSGM2DKNRXHA4TAMJSGM2DKNRXHA4TAJKY';
const VALID_PUBLIC_KEY = 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5';
const metadata: ArgumentMetadata = { type: 'body', metatype: Object };

describe('Soroban payload schemas', () => {
  describe('sorobanInvocationSchema', () => {
    it('accepts a valid contract invocation with nested JSON arguments', () => {
      const result = sorobanInvocationSchema.parse({
        contractId: VALID_CONTRACT_ID,
        functionName: 'transfer',
        args: ['G...recipient', '100', { decimals: 7, memo: null }],
        feeLimit: 100_000,
        auth: { sourceAccount: VALID_PUBLIC_KEY, signature: 'signature' },
      });

      expect(result.args).toHaveLength(3);
    });

    it('rejects malformed contract IDs and function names', () => {
      expect(
        sorobanInvocationSchema.safeParse({
          contractId: 'a'.repeat(64),
          functionName: 'transfer-now',
        }).success,
      ).toBe(false);
    });

    it('rejects non-JSON arguments and more than 100 arguments', () => {
      expect(
        sorobanInvocationSchema.safeParse({
          contractId: VALID_CONTRACT_ID,
          functionName: 'invoke',
          args: [new Date()],
        }).success,
      ).toBe(false);
      expect(
        sorobanInvocationSchema.safeParse({
          contractId: VALID_CONTRACT_ID,
          functionName: 'invoke',
          args: Array(101).fill(null),
        }).success,
      ).toBe(false);
    });

    it('rejects out-of-range fees and malformed authentication fields', () => {
      const validPayload = { contractId: VALID_CONTRACT_ID, functionName: 'invoke' };

      expect(
        sorobanInvocationSchema.safeParse({ ...validPayload, feeLimit: 100_000_001 }).success,
      ).toBe(false);
      expect(
        sorobanInvocationSchema.safeParse({
          ...validPayload,
          auth: { sourceAccount: 'Ginvalid' },
        }).success,
      ).toBe(false);
    });

    it('rejects additional properties', () => {
      expect(
        sorobanInvocationSchema.safeParse({
          contractId: VALID_CONTRACT_ID,
          functionName: 'invoke',
          admin: true,
        }).success,
      ).toBe(false);
    });
  });

  describe('sorobanTransactionSchema', () => {
    it('accepts a base64-encoded transaction envelope and optional metadata', () => {
      expect(
        sorobanTransactionSchema.parse({
          xdr: 'AAAA',
          network: 'TESTNET',
          skipSimulation: false,
        }).network,
      ).toBe('TESTNET');
    });

    it('rejects malformed base64, unsupported networks, and extra fields', () => {
      expect(sorobanTransactionSchema.safeParse({ xdr: '***' }).success).toBe(false);
      expect(sorobanTransactionSchema.safeParse({ xdr: 'AAAA', network: 'LOCAL' }).success).toBe(
        false,
      );
      expect(sorobanTransactionSchema.safeParse({ xdr: 'AAAA', admin: true }).success).toBe(false);
    });

    it('returns a 400 validation exception with field-level details', () => {
      const pipe = new SorobanValidationPipe(sorobanInvocationSchema);

      try {
        pipe.transform({ contractId: 'invalid', functionName: '' }, metadata);
        expect.fail('Expected payload validation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(ZodValidationException);
        expect((error as ZodValidationException).getStatus()).toBe(400);
        expect((error as ZodValidationException).details).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: 'contractId' }),
            expect.objectContaining({ path: 'functionName' }),
          ]),
        );
      }
    });
  });
});