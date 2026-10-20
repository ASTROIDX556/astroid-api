import { registerAs } from '@nestjs/config';
import { stellarEnvSchema, validateEnv } from './env.validation';

export type StellarConfig = {
  network: 'testnet' | 'public' | 'futurenet';
  horizonUrl: string;
  sorobanRpcUrl: string;
  registryContractId: string;
  useMock: boolean;
  /**
   * Stellar Anchor assets the platform accepts as a bare ticker, keyed by the
   * upper-case asset code (e.g. `USDC`) and holding the issuing account.
   */
  anchorAssets: Record<string, string>;
};

/**
 * Parses the `CODE=ISSUER` anchor asset list. Malformed entries are rejected
 * at boot so a typo can never make an asset unresolvable at runtime.
 */
export function parseAnchorAssets(raw: string): Record<string, string> {
  const assets: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Invalid STELLAR_ANCHOR_ASSETS entry '${trimmed}': expected CODE=ISSUER`);
    }
    const code = trimmed.slice(0, separator).trim().toUpperCase();
    const issuer = trimmed.slice(separator + 1).trim();
    if (!/^[A-Z0-9]{1,12}$/.test(code)) {
      throw new Error(
        `Invalid STELLAR_ANCHOR_ASSETS entry '${trimmed}': asset code must be 1-12 alphanumeric characters`,
      );
    }
    if (!/^G[A-Z2-7]{55}$/.test(issuer)) {
      throw new Error(
        `Invalid STELLAR_ANCHOR_ASSETS entry '${trimmed}': issuer must be a Stellar account address (G…)`,
      );
    }
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
    anchorAssets: parseAnchorAssets(env.STELLAR_ANCHOR_ASSETS),
  };
});
