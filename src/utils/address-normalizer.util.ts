const STELLAR_PUBKEY_REGEX = /^G[A-Z2-7]{55}$/;
const STELLAR_CONTRACT_REGEX = /^C[A-Z2-7]{55}$/;

export function normalizeAccountOrContractAddress(raw: string): string {
  const cleaned = raw.trim().toUpperCase();
  if (!STELLAR_PUBKEY_REGEX.test(cleaned) && !STELLAR_CONTRACT_REGEX.test(cleaned)) {
    throw new Error('Invalid Stellar public key or contract address format');
  }
  return cleaned;
}
