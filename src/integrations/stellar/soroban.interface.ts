/**
 * Soroban RPC client abstraction. Mirrors the Stellar SDK's
 * `SorobanRpc.Server.simulateTransaction` surface but decoupled so the
 * platform never imports `@stellar/stellar-sdk` Soroban types directly.
 */

export const SOROBAN_CLIENT = Symbol('SOROBAN_CLIENT');

export interface SorobanSimulationOptions {
  /** The base64-encoded transaction envelope XDR to simulate. */
  transactionXdr: string;
  /** Optional: auth entries to inject for unauthorized simulation. */
  auth?: Array<{ address: string; footprint: unknown }>;
}

export interface SorobanContractEvent {
  type: string;
  contractId: string;
  topic: string[];
  value: unknown;
}

export interface SorobanSimulationResult {
  /** Whether the simulation succeeded without error. */
  success: boolean;
  /** The estimated base fee in stroops (as string for precision). */
  minResourceFee: string;
  /** The cost analysis including cpu and memory resources. */
  cost: {
    cpuInstructions: number;
    memoryBytes: number;
  };
  /** Footprint of contract read/write keys accessed during simulation. */
  footprint: {
    readOnly: Array<{ contractId: string; key: unknown }>;
    readWrite: Array<{ contractId: string; key: unknown }>;
  };
  /** Events emitted during simulation (logs). */
  events: SorobanContractEvent[];
  /** The simulated result value (base64 XDR). */
  result?: string;
  /** Error details if simulation failed. */
  error?: {
    code: string;
    message: string;
  };
  /** Transaction hash from the simulation. */
  transactionHash?: string;
}

export interface SorobanClient {
  /**
   * Simulates a Soroban transaction against the network.
   * Returns fee estimates, footprint data, events, and success/failure status.
   */
  simulateTransaction(options: SorobanSimulationOptions): Promise<SorobanSimulationResult>;
}
