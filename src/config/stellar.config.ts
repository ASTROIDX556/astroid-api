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
  anchorAssets: Record<string, string>;
};

export function parseAnchorAssets(raw: string): Record<string, string> {
  const assets: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) throw new Error(`Invalid STELLAR_ANCHOR_ASSETS entry '${trimmed}': expected CODE=ISSUER`);
    const code = trimmed.slice(0, separator).trim().toUpperCase();
    const issuer = trimmed.slice(separator + 1).trim();
    if (!/^[A-Z0-9]{1,12}$/.test(code)) throw new Error('Stellar asset code must be 1-12 alphanumeric characters');
    if (!/^G[A-Z2-7]{55}$/.test(issuer)) throw new Error('Stellar account address is invalid');
    assets[code] = issuer;
  }
  return assets;
}

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
    anchorAssets: parseAnchorAssets(env.STELLAR_ANCHOR_ASSETS),
  };
});
