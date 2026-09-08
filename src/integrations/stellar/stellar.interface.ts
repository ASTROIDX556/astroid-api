/**
 * The isolated Stellar integration contract. This is the ONLY surface through
 * which the platform talks to the Stellar network. Everything else depends on
 * this interface, never on `@stellar/stellar-sdk` directly, so the network can
 * be swapped for a deterministic mock in tests and local development.
 */

export const STELLAR_CLIENT = Symbol('STELLAR_CLIENT');

export type StellarNetworkName = 'testnet' | 'public' | 'futurenet';

export interface StellarKeypair {
  publicKey: string;
  secretKey: string;
}

export interface StellarBalance {
  asset: string;
  balance: string;
  assetType: string;
}

export interface BuildPaymentParams {
  sourceAddress: string;
  destinationAddress: string;
  asset: string;
  amount: string;
  memo?: string;
  network: StellarNetworkName;
}

export interface SubmitPaymentParams extends BuildPaymentParams {
  /** Optional source secret enabling a real testnet submission (server-side). */
  sourceSecret?: string;
  /** Optional pre-signed transaction envelope (base64 XDR). */
  signedXdr?: string;
}

export interface StellarSubmitResult {
  hash: string;
  ledger?: number;
  successful: boolean;
}

export interface StellarTransactionInfo {
  hash: string;
  successful: boolean;
  ledger?: number;
  createdAt: string;
}

export interface StellarClient {
  /** Creates a new Ed25519 keypair (public + secret). */
  generateKeypair(): StellarKeypair;

  /** Returns true if the address is a syntactically valid Stellar public key. */
  isValidAddress(address: string): boolean;

  /** Loads all asset balances for an account. */
  getBalances(address: string, network: StellarNetworkName): Promise<StellarBalance[]>;

  /** Convenience accessor for the native (XLM) balance. */
  getNativeBalance(address: string, network: StellarNetworkName): Promise<string>;

  /** Builds an unsigned payment transaction, returning its base64 XDR. */
  buildPaymentXdr(params: BuildPaymentParams): Promise<string>;

  /** Submits a payment to the network (mock, or real when a secret is given). */
  submitPayment(params: SubmitPaymentParams): Promise<StellarSubmitResult>;

  /** Fetches a submitted transaction by hash, or null if not found. */
  getTransaction(hash: string, network: StellarNetworkName): Promise<StellarTransactionInfo | null>;
}
