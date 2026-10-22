import { registerAs } from '@nestjs/config';
import { stellarEnvSchema, validateEnv } from './env.validation';

export type StellarConfig = {
  network: 'testnet' | 'public' | 'futurenet';
  horizonUrl: string;
  sorobanRpcUrl: string;
  registryContractId: string;
  useMock: boolean;
  /** Percentage added to simulated gas limits for congestion headroom. */
  gasSafetyBufferPercent: number;
  /** Network block gas limit (Soroban CPU instructions per transaction). */
  maxGasLimit: number;
  /** Static gas limit used when dynamic estimation fails. */
  fallbackGasLimit: number;
  /** Static fee limit in stroops paired with {@link fallbackGasLimit}. */
  fallbackFeeStroops: number;
};

export const stellarConfig = registerAs('stellar', (): StellarConfig => {
  const env = validateEnv(stellarEnvSchema, process.env);
  return {
    network: env.STELLAR_NETWORK,
    horizonUrl: env.STELLAR_HORIZON_URL,
    sorobanRpcUrl: env.STELLAR_SOROBAN_RPC_URL,
    registryContractId: env.STELLAR_REGISTRY_CONTRACT_ID,
    useMock: env.STELLAR_USE_MOCK,
    gasSafetyBufferPercent: env.STELLAR_GAS_SAFETY_BUFFER_PERCENT,
    maxGasLimit: env.STELLAR_MAX_GAS_LIMIT,
    fallbackGasLimit: env.STELLAR_FALLBACK_GAS_LIMIT,
    fallbackFeeStroops: env.STELLAR_FALLBACK_FEE_STROOPS,
  };
});
