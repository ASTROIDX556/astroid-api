import { registerAs } from '@nestjs/config';
import { stellarEnvSchema, validateEnv } from './env.validation';

export type FeeFallbackMode = 'fail' | 'congestion';

export type FeeProtectionConfig = {
  enabled: boolean;
  maxBaseFee: number; // in stroops
  fallbackMode: FeeFallbackMode;
  feeStatsIntervalMs: number;
};

export type StellarConfig = {
  network: 'testnet' | 'public' | 'futurenet';
  horizonUrl: string;
  sorobanRpcUrl: string;
  registryContractId: string;
  useMock: boolean;
  feeProtection: FeeProtectionConfig;
};

export const stellarConfig = registerAs('stellar', (): StellarConfig => {
  const env = validateEnv(stellarEnvSchema, process.env);
  
  // Determine fee protection settings from environment with fallbacks
  const feeProtectionEnabled = process.env.FEE_PROTECTION_ENABLED !== 'false';
  const maxBaseFeeRaw = process.env.STELLAR_MAX_BASE_FEE ?? '100000';
  const maxBaseFee = Number(maxBaseFeeRaw);
  if (!Number.isFinite(maxBaseFee) || maxBaseFee <= 0) {
    throw new Error(`Invalid STELLAR_MAX_BASE_FEE: ${maxBaseFeeRaw}`);
  }
  const fallbackModeRaw = process.env.STELLAR_FEE_FALLBACK_MODE ?? 'fail';
  const fallbackMode: FeeFallbackMode = fallbackModeRaw === 'congestion' ? 'congestion' : 'fail';
  const feeStatsIntervalMsRaw = process.env.STELLAR_FEE_STATS_INTERVAL_MS ?? '30000';
  const feeStatsIntervalMs = Number(feeStatsIntervalMsRaw);
  if (!Number.isFinite(feeStatsIntervalMs) || feeStatsIntervalMs <= 0) {
    throw new Error(`Invalid STELLAR_FEE_STATS_INTERVAL_MS: ${feeStatsIntervalMsRaw}`);
  }

  return {
    network: env.STELLAR_NETWORK,
    horizonUrl: env.STELLAR_HORIZON_URL,
    sorobanRpcUrl: env.STELLAR_SOROBAN_RPC_URL,
    registryContractId: env.STELLAR_REGISTRY_CONTRACT_ID,
    useMock: env.STELLAR_USE_MOCK,
    feeProtection: {
      enabled: feeProtectionEnabled,
      maxBaseFee,
      fallbackMode,
      feeStatsIntervalMs,
    },
  };
});
