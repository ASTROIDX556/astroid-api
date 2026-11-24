import { Logger } from '@nestjs/common';
import { Address, scValToNative, StrKey, xdr } from '@stellar/stellar-sdk';
import {
  SorobanClient,
  SorobanContractEvent,
  SorobanSimulationOptions,
  SorobanSimulationResult,
} from './soroban.interface';
import { SorobanRpcClient } from './soroban.client';

/** Raw `simulateTransaction` result as returned by Soroban RPC. */
export interface RawSimulateTransactionResult {
  latestLedger?: number;
  minResourceFee?: string;
  cost?: { cpuInsns?: string; memBytes?: string };
  results?: Array<{ auth?: string[]; xdr?: string }>;
  transactionData?: string;
  events?: string[];
  error?: string;
}

interface RawLatestLedgerResult {
  sequence: number | string;
}

type FootprintEntry = { contractId: string; key: unknown };

/**
 * {@link SorobanClient} backed by a real Soroban RPC endpoint. Every call goes
 * through {@link SorobanRpcClient}, which owns the timeout, retry and circuit
 * breaker policy; this class only translates between the JSON-RPC payloads and
 * the platform's {@link SorobanSimulationResult} shape.
 *
 * Decoding of footprint and events is best effort: an entry the SDK cannot
 * decode is skipped (and logged at debug) rather than failing a simulation
 * that the network reported as successful.
 */
export class HttpSorobanClient implements SorobanClient {
  private readonly logger = new Logger(HttpSorobanClient.name);

  constructor(private readonly rpc: SorobanRpcClient) {}

  async simulateTransaction(options: SorobanSimulationOptions): Promise<SorobanSimulationResult> {
    const raw = await this.rpc.call<RawSimulateTransactionResult>('simulateTransaction', {
      transaction: options.transactionXdr,
    });
    return this.toResult(raw);
  }

  async getLatestLedger(): Promise<number> {
    const raw = await this.rpc.call<RawLatestLedgerResult>('getLatestLedger');
    const sequence = Number(raw.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error('Soroban RPC returned an invalid latest ledger sequence');
    }
    return sequence;
  }

  private toResult(raw: RawSimulateTransactionResult): SorobanSimulationResult {
    const transactionData = this.decodeTransactionData(raw.transactionData);
    const result: SorobanSimulationResult = {
      success: !raw.error,
      latestLedger: raw.latestLedger,
      minResourceFee: raw.minResourceFee ?? '0',
      cost: {
        cpuInstructions: toNumber(raw.cost?.cpuInsns) ?? transactionData?.resources().instructions() ?? 0,
        memoryBytes: toNumber(raw.cost?.memBytes) ?? 0,
      },
      footprint: this.footprint(transactionData),
      events: this.events(raw.events),
      result: raw.results?.[0]?.xdr,
    };
    if (raw.error) {
      result.error = { code: 'SIMULATION_FAILED', message: raw.error };
    }
    return result;
  }

  private decodeTransactionData(encoded?: string): xdr.SorobanTransactionData | undefined {
    if (!encoded) return undefined;
    try {
      return xdr.SorobanTransactionData.fromXDR(encoded, 'base64');
    } catch {
      this.logger.debug('Could not decode simulation transactionData; footprint omitted');
      return undefined;
    }
  }

  private footprint(data?: xdr.SorobanTransactionData): SorobanSimulationResult['footprint'] {
    if (!data) return { readOnly: [], readWrite: [] };
    const footprint = data.resources().footprint();
    return {
      readOnly: footprint.readOnly().map(footprintEntry),
      readWrite: footprint.readWrite().map(footprintEntry),
    };
  }

  private events(encoded?: string[]): SorobanContractEvent[] {
    if (!encoded) return [];
    const events: SorobanContractEvent[] = [];
    for (const entry of encoded) {
      try {
        const event = xdr.DiagnosticEvent.fromXDR(entry, 'base64').event();
        const contractId = event.contractId();
        const body = event.body().v0();
        events.push({
          type: event.type().name,
          contractId: contractId ? StrKey.encodeContract(contractId) : '',
          topic: body.topics().map((topic) => String(jsonSafe(scValToNative(topic)))),
          value: jsonSafe(scValToNative(body.data())),
        });
      } catch {
        this.logger.debug('Skipping undecodable simulation event');
      }
    }
    return events;
  }
}

function footprintEntry(key: xdr.LedgerKey): FootprintEntry {
  let contractId = '';
  if (key.switch() === xdr.LedgerEntryType.contractData()) {
    contractId = Address.fromScAddress(key.contractData().contract()).toString();
  } else if (key.switch() === xdr.LedgerEntryType.contractCode()) {
    contractId = key.contractCode().hash().toString('hex');
  }
  return { contractId, key: key.toXDR('base64') };
}

function toNumber(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Converts SDK-native values (bigint, Buffer) into JSON-serialisable ones. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}
