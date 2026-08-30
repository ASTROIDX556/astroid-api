import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StellarService } from './stellar.service';
import { StellarBalance, StellarClient, StellarNetworkName } from '../../integrations/stellar';
import { CircuitOpenException, DomainException } from '../../common/exceptions/domain.exception';
import { ErrorCode } from '../../common/constants/error-codes';

function buildMockStellarClient(): StellarClient {
  return {
    generateKeypair: vi.fn(),
    isValidAddress: vi.fn().mockReturnValue(true),
    getBalances: vi.fn(),
    getNativeBalance: vi.fn(),
    buildPaymentXdr: vi.fn(),
    submitPayment: vi.fn(),
    getTransaction: vi.fn(),
  };
}

describe('StellarService', () => {
  let client: ReturnType<typeof buildMockStellarClient>;
  let service: StellarService;

  beforeEach(() => {
    vi.clearAllMocks();
    client = buildMockStellarClient();
    service = new StellarService(client);
  });

  describe('normal operation', () => {
    it('delegates getBalances to the injected client', async () => {
      const balances: StellarBalance[] = [{ asset: 'XLM', balance: '100', assetType: 'native' }];
      (client.getBalances as ReturnType<typeof vi.fn>).mockResolvedValue(balances);

      const result = await service.getBalances('GADDR', 'testnet' as StellarNetworkName);

      expect(result).toEqual(balances);
      expect(client.getBalances).toHaveBeenCalledWith('GADDR', 'testnet');
    });

    it('wraps a genuine client failure as a STELLAR_ERROR DomainException', async () => {
      (client.getNativeBalance as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection refused'),
      );

      await expect(
        service.getNativeBalance('GADDR', 'testnet' as StellarNetworkName),
      ).rejects.toMatchObject({ code: ErrorCode.STELLAR_ERROR });
    });
  });

  describe('circuit breaker integration', () => {
    it('opens the circuit after repeated failures and fails fast without calling the client again', async () => {
      (client.getNativeBalance as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('Horizon is down'), { code: 'ECONNREFUSED' }),
      );

      // Default threshold is 5 consecutive failures — drive it there.
      for (let i = 0; i < 5; i++) {
        await expect(
          service.getNativeBalance('GADDR', 'testnet' as StellarNetworkName),
        ).rejects.toMatchObject({ code: ErrorCode.STELLAR_ERROR });
      }
      expect(client.getNativeBalance).toHaveBeenCalledTimes(5);

      (client.getNativeBalance as ReturnType<typeof vi.fn>).mockClear();

      // Circuit is now OPEN: the underlying client must not be invoked again,
      // and the error surfaced must be a CircuitOpenException distinguishable
      // from a plain STELLAR_ERROR.
      let thrown: unknown;
      try {
        await service.getNativeBalance('GADDR', 'testnet' as StellarNetworkName);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(CircuitOpenException);
      expect(thrown).toBeInstanceOf(DomainException);
      expect((thrown as DomainException).code).toBe(ErrorCode.CIRCUIT_OPEN);
      expect(client.getNativeBalance).not.toHaveBeenCalled();
    });

    it('fails fast for every wrapped method once the shared breaker is open', async () => {
      (client.getBalances as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('down'), { code: 'ETIMEDOUT' }),
      );

      for (let i = 0; i < 5; i++) {
        await expect(
          service.getBalances('GADDR', 'testnet' as StellarNetworkName),
        ).rejects.toMatchObject({ code: ErrorCode.STELLAR_ERROR });
      }

      // A different wrapped method now also fails fast via the same breaker.
      (client.buildPaymentXdr as ReturnType<typeof vi.fn>).mockResolvedValue('xdr');
      await expect(
        service.buildPaymentXdr({
          sourceAddress: 'GSRC',
          destinationAddress: 'GDST',
          asset: 'native',
          amount: '10',
          network: 'testnet' as StellarNetworkName,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.CIRCUIT_OPEN });
      expect(client.buildPaymentXdr).not.toHaveBeenCalled();
    });
  });
});
