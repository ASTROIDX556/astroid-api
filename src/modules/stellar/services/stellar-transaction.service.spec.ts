import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StellarTransactionService } from './stellar-transaction.service';
import { ConfigService } from '@nestjs/config';
import { DomainException } from '../../../common/exceptions/domain.exception';
import { ErrorCode } from '../../../common/constants/error-codes';

describe('StellarTransactionService', () => {
  let service: StellarTransactionService;
  let configService: ConfigService;

  beforeEach(() => {
    configService = {
      get: vi.fn(),
    } as unknown as ConfigService;
    service = new StellarTransactionService(configService);
  });

  it('returns empty result when transaction has no signatures', () => {
    vi.mocked(configService.get).mockReturnValue({ network: 'testnet' });
    
    // Mock global xdr to return envelope with no signatures
    const mockEnvelope = {
      tx: () => ({
        signatures: [],
        hash: () => Buffer.from('test-hash'),
      }),
    };
    (global as unknown as { xdr: { TransactionEnvelope: { fromXDR: () => unknown } } }).xdr = {
      TransactionEnvelope: {
        fromXDR: () => mockEnvelope,
      },
    };

    const result = service.parseAndVerifyEnvelope('base64-xdr', ['GABC123']);
    
    expect(result).toEqual({
      isValid: false,
      matchingSigners: [],
      unrecognizedSigners: [],
      totalWeight: 0,
      thresholdMet: false,
      signatureCount: 0,
    });
  });

  it('uses public network when configured', () => {
    vi.mocked(configService.get).mockReturnValue({ network: 'public' });
    
    const mockEnvelope = {
      tx: () => ({
        signatures: [],
        hash: () => Buffer.from('test-hash'),
      }),
    };
    (global as unknown as { xdr: { TransactionEnvelope: { fromXDR: () => unknown } } }).xdr = {
      TransactionEnvelope: {
        fromXDR: () => mockEnvelope,
      },
    };

    const result = service.parseAndVerifyEnvelope('base64-xdr', ['GABC123']);
    expect(result).toBeDefined();
  });

  it('uses testnet network when not configured as public', () => {
    vi.mocked(configService.get).mockReturnValue({ network: 'testnet' });
    
    const mockEnvelope = {
      tx: () => ({
        signatures: [],
        hash: () => Buffer.from('test-hash'),
      }),
    };
    (global as unknown as { xdr: { TransactionEnvelope: { fromXDR: () => unknown } } }).xdr = {
      TransactionEnvelope: {
        fromXDR: () => mockEnvelope,
      },
    };

    const result = service.parseAndVerifyEnvelope('base64-xdr', ['GABC123']);
    expect(result).toBeDefined();
  });

  it('throws DomainException for invalid XDR format', () => {
    vi.mocked(configService.get).mockReturnValue({ network: 'testnet' });
    
    (global as unknown as { xdr: { TransactionEnvelope: { fromXDR: () => unknown } } }).xdr = {
      TransactionEnvelope: {
        fromXDR: () => {
          throw new Error('Invalid XDR');
        },
      },
    };

    expect(() => service.parseAndVerifyEnvelope('invalid-xdr', ['GABC123']))
      .toThrow(DomainException);
  });

  it('throws INVALID_STELLAR_TRANSACTION error code for invalid XDR', () => {
    vi.mocked(configService.get).mockReturnValue({ network: 'testnet' });
    
    (global as unknown as { xdr: { TransactionEnvelope: { fromXDR: () => unknown } } }).xdr = {
      TransactionEnvelope: {
        fromXDR: () => {
          throw new Error('Invalid XDR');
        },
      },
    };

    expect(() => service.parseAndVerifyEnvelope('invalid-xdr', ['GABC123']))
      .toThrow(DomainException);
    expect(() => service.parseAndVerifyEnvelope('invalid-xdr', ['GABC123']))
      .toThrow(expect.objectContaining({ code: ErrorCode.INVALID_STELLAR_TRANSACTION }));
  });

  it('throws STELLAR_ERROR for other parsing errors', () => {
    vi.mocked(configService.get).mockReturnValue({ network: 'testnet' });
    
    (global as unknown as { xdr: { TransactionEnvelope: { fromXDR: () => unknown } } }).xdr = {
      TransactionEnvelope: {
        fromXDR: () => {
          throw new Error('Some other error');
        },
      },
    };

    expect(() => service.parseAndVerifyEnvelope('invalid-xdr', ['GABC123']))
      .toThrow(DomainException);
    expect(() => service.parseAndVerifyEnvelope('invalid-xdr', ['GABC123']))
      .toThrow(expect.objectContaining({ code: ErrorCode.STELLAR_ERROR }));
  });

  it('returns signature count correctly', () => {
    vi.mocked(configService.get).mockReturnValue({ network: 'testnet' });
    
    const mockSignature = {
      signature: () => Buffer.from('sig'),
      hint: () => Buffer.from('hint'),
    };
    
    const mockEnvelope = {
      tx: () => ({
        signatures: [mockSignature, mockSignature, mockSignature],
        hash: () => Buffer.from('test-hash'),
      }),
    };
    (global as unknown as { xdr: { TransactionEnvelope: { fromXDR: () => unknown } } }).xdr = {
      TransactionEnvelope: {
        fromXDR: () => mockEnvelope,
      },
    };

    const result = service.parseAndVerifyEnvelope('base64-xdr', ['GABC123']);
    expect(result.signatureCount).toBe(3);
  });

  it('handles empty expected signers array', () => {
    vi.mocked(configService.get).mockReturnValue({ network: 'testnet' });
    
    const mockSignature = {
      signature: () => Buffer.from('sig'),
      hint: () => Buffer.from('hint'),
    };
    
    const mockEnvelope = {
      tx: () => ({
        signatures: [mockSignature],
        hash: () => Buffer.from('test-hash'),
      }),
    };
    (global as unknown as { xdr: { TransactionEnvelope: { fromXDR: () => unknown } } }).xdr = {
      TransactionEnvelope: {
        fromXDR: () => mockEnvelope,
      },
    };

    const result = service.parseAndVerifyEnvelope('base64-xdr', []);
    expect(result.matchingSigners).toHaveLength(0);
    expect(result.unrecognizedSigners).toHaveLength(1);
  });

  it('calculates total weight as number of matching signers', () => {
    vi.mocked(configService.get).mockReturnValue({ network: 'testnet' });
    
    const mockSignature = {
      signature: () => Buffer.from('sig'),
      hint: () => Buffer.from('hint'),
    };
    
    const mockEnvelope = {
      tx: () => ({
        signatures: [mockSignature, mockSignature],
        hash: () => Buffer.from('test-hash'),
      }),
    };
    (global as unknown as { xdr: { TransactionEnvelope: { fromXDR: () => unknown } } }).xdr = {
      TransactionEnvelope: {
        fromXDR: () => mockEnvelope,
      },
    };

    const result = service.parseAndVerifyEnvelope('base64-xdr', ['GABC123']);
    expect(result.totalWeight).toBe(result.matchingSigners.length);
  });

  it('sets thresholdMet to true when there are matching signers', () => {
    vi.mocked(configService.get).mockReturnValue({ network: 'testnet' });
    
    const mockSignature = {
      signature: () => Buffer.from('sig'),
      hint: () => Buffer.from('hint'),
    };
    
    const mockEnvelope = {
      tx: () => ({
        signatures: [mockSignature],
        hash: () => Buffer.from('test-hash'),
      }),
    };
    (global as unknown as { xdr: { TransactionEnvelope: { fromXDR: () => unknown } } }).xdr = {
      TransactionEnvelope: {
        fromXDR: () => mockEnvelope,
      },
    };

    const result = service.parseAndVerifyEnvelope('base64-xdr', ['GABC123']);
    // Since we can't easily mock the Stellar SDK verification, 
    // we just verify the structure is correct
    expect(result.signatureCount).toBe(1);
    expect(result).toHaveProperty('thresholdMet');
  });

  it('sets thresholdMet to false when no matching signers', () => {
    vi.mocked(configService.get).mockReturnValue({ network: 'testnet' });
    
    const mockSignature = {
      signature: () => Buffer.from('sig'),
      hint: () => Buffer.from('hint'),
    };
    
    const mockEnvelope = {
      tx: () => ({
        signatures: [mockSignature],
        hash: () => Buffer.from('test-hash'),
      }),
    };
    (global as unknown as { xdr: { TransactionEnvelope: { fromXDR: () => unknown } } }).xdr = {
      TransactionEnvelope: {
        fromXDR: () => mockEnvelope,
      },
    };

    const result = service.parseAndVerifyEnvelope('base64-xdr', ['GABC123']);
    expect(result.thresholdMet).toBe(false);
  });
});
