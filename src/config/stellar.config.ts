import { registerAs } from 'nestjs/config';
import { stellarEnvSchema, validateEnv } from './env.validation';

export type StellarConfig = {
  network: 'testnet' | 'public' | 'futurenet';
  horizonUrl: string;
  sorobanRpcUrl: string;
  registryContractId: string;
  useMock: boolean;
  maxBaseFee: number;
  congestionFallback: 'fail' | 'flag';
};

export const stellarConfig = registerAs('stellar', (): StellarConfig => {
  const env = validateEnv(stellarEnvSchema, process.env);
  return {
    network: env.STELLAR_NETWORK,
    horizonUrl: env.STELLAR_HORIZON_URL,
    sorobanRpcUrl: env.STELLAR_SOROBAN_RPC_URL,
    registryContractId: env.STELLAR_REGISTRY_CONTRACT_ID,
    useMock: env.STELLAR_USE_MOCK,
    maxBaseFee: Number(process.env.MAX_BASE_FEE ?? 100000),
    congestionFallback: process.env.CONGESTION_FALLBACK === 'flag' ? 'flag' : 'fail',
  };
});
