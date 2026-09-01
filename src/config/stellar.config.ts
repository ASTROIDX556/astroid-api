import { registerAs } from '@nestjs/config';
import { stellarEnvSchema, validateEnv } from './env.validation';

export type StellarConfig = {
  network: 'testnet' | 'public' | 'futurenet';
  horizonUrl: string;
  sorobanRpcUrl: string;
  registryContractId: string;
  useMock: boolean;
  maxBaseFee: number;
  feeStatsCacheTtlMs: number;
  congestionFallbackMode: 'FAIL / 'FAILED_CONGESTION';
};

export const stellarConfig = registerAs('stellar', (): StellarConfig => {
  const env = validateEnv(stellarEnvSchema, process.env);
  return {
    network: env.STELLAR_NETWORK,
    horizonUrl: env.STELLAR_HORIZON_URL,
    sorobanRpcUrl: env.STELLAR_SOROBAN_RPC_URL,
    registryContractId: env.STELLAR_REGISTRY_CONTRACT_ID,
    useMock: env.STELLAR_USE_MOCK,
    maxBaseFee: Number(process.env.STELLAR_MAX_BASE_FEE ?? 1000),
    feeStatsCacheTtlMs: Number(process.env.STELLAR_FEE_STATS_CACHE_TTL_MS ?? 30000),
    congestionFallbackMode:
      process.env.STELLAR_CONGESTION_FALLBACK_MODE==='FAIL'
        ? 'FAIL'
        : 'FAILED_CONGESTION',
  };
});
