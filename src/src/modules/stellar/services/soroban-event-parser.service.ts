import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { xdr, scValToNative, Address } from '@stellar/stellar-sdk';
import { DomainEventName } from '../../../events/event-names';

/** Raw event shape from Stellar RPC `getEvents` / tx meta. */
export interface RawSorobanEvent {
  type?: string;
  ledger?: number;
  ledgerClosedAt?: string;
  contractId?: string;
  id?: string;
  pagingToken?: string;
  /** Base64-encoded SCVal XDR topics */
  topic?: string[];
  /** Base64-encoded SCVal XDR value */
  value?: string;
  inSuccessfulContractCall?: boolean;
  txHash?: string;
}

export interface ParsedTopic {
  index: number;
  rawBase64: string;
  native: unknown;
  kind: string;
}

export interface ParsedSorobanEvent {
  contractId: string | null;
  txHash: string | null;
  ledger: number | null;
  type: string | null;
  topics: ParsedTopic[];
  value: unknown;
  /** High-level classification when recognized */
  pattern: SorobanEventPattern;
  /** Normalized payload for known patterns */
  normalized: SacTransferEvent | SacMintEvent | SacBurnEvent | Record<string, unknown> | null;
}

export type SorobanEventPattern =
  | 'sac.transfer'
  | 'sac.mint'
  | 'sac.burn'
  | 'sac.approve'
  | 'unknown'
  | 'unparseable';

export interface SacTransferEvent {
  pattern: 'sac.transfer';
  contractId: string | null;
  from: string | null;
  to: string | null;
  amount: string | null;
  txHash: string | null;
  ledger: number | null;
}

export interface SacMintEvent {
  pattern: 'sac.mint';
  contractId: string | null;
  to: string | null;
  amount: string | null;
  txHash: string | null;
  ledger: number | null;
}

export interface SacBurnEvent {
  pattern: 'sac.burn';
  contractId: string | null;
  from: string | null;
  amount: string | null;
  txHash: string | null;
  ledger: number | null;
}

/** Nest domain event name for successfully parsed Soroban events. */
export const SOROBAN_EVENT_PARSED = 'stellar.soroban_event_parsed';

@Injectable()
export class SorobanEventParserService {
  private readonly logger = new Logger(SorobanEventParserService.name);

  constructor(private readonly emitter: EventEmitter2) {}

  /**
   * Parse a batch of raw RPC events. Never throws for individual bad rows —
   * unparseable entries are logged and returned with pattern `unparseable`.
   */
  parseEvents(rawEvents: RawSorobanEvent[]): ParsedSorobanEvent[] {
    if (!Array.isArray(rawEvents)) {
      this.logger.warn('parseEvents called with non-array input');
      return [];
    }
    return rawEvents.map((raw) => this.parseOne(raw));
  }

  /**
   * Parse, classify, and emit domain events for successfully translated rows.
   * Safe for worker loops: decode failures do not throw.
   */
  async ingestAndEmit(rawEvents: RawSorobanEvent[]): Promise<ParsedSorobanEvent[]> {
    const parsed = this.parseEvents(rawEvents);

    for (const event of parsed) {
      if (event.pattern === 'unparseable') {
        continue;
      }
      try {
        this.emitter.emit(SOROBAN_EVENT_PARSED, event);

        if (event.pattern === 'sac.transfer' && event.normalized) {
          this.emitter.emit(DomainEventName.TransactionConfirmed, {
            source: 'soroban',
            ...event.normalized,
          });
        }
      } catch (err) {
        this.logger.warn(
          `EventEmitter failed for contract=${event.contractId}: ${(err as Error).message}`,
        );
      }
    }

    return parsed;
  }

  parseOne(raw: RawSorobanEvent): ParsedSorobanEvent {
    const base: ParsedSorobanEvent = {
      contractId: raw.contractId ?? null,
      txHash: raw.txHash ?? null,
      ledger: typeof raw.ledger === 'number' ? raw.ledger : null,
      type: raw.type ?? null,
      topics: [],
      value: null,
      pattern: 'unparseable',
      normalized: null,
    };

    try {
      const topics = this.decodeTopics(raw.topic ?? []);
      const value = this.decodeScValBase64(raw.value);

      base.topics = topics;
      base.value = value;

      const classified = this.classify(base.contractId, topics, value, base.txHash, base.ledger);
      base.pattern = classified.pattern;
      base.normalized = classified.normalized;
      return base;
    } catch (err) {
      this.logger.warn(
        `Failed to parse Soroban event contractId=\( {raw.contractId ?? '?'} tx= \){raw.txHash ?? '?'}: ${(err as Error).message}`,
      );
      return base;
    }
  }

  private decodeTopics(topics: string[]): ParsedTopic[] {
    const out: ParsedTopic[] = [];
    for (let i = 0; i < topics.length; i++) {
      const rawBase64 = topics[i];
      try {
        const native = this.decodeScValBase64(rawBase64);
        out.push({
          index: i,
          rawBase64,
          native,
          kind: this.topicKind(native),
        });
      } catch (err) {
        this.logger.warn(
          `Unparseable topic[${i}]: ${(err as Error).message}`,
        );
        out.push({
          index: i,
          rawBase64,
          native: null,
          kind: 'error',
        });
      }
    }
    return out;
  }

  /**
   * Decode a single base64 SCVal XDR blob to a JS native value.
   * Throws on malformed input — callers catch per-item.
   */
  decodeScValBase64(base64: string | undefined | null): unknown {
    if (base64 === undefined || base64 === null || base64 === '') {
      return null;
    }
    const buf = Buffer.from(base64, 'base64');
    const scVal = xdr.ScVal.fromXDR(buf);
    return scValToNative(scVal);
  }

  private topicKind(native: unknown): string {
    if (native === null || native === undefined) return 'null';
    if (typeof native === 'string') return 'string';
    if (typeof native === 'bigint' || typeof native === 'number') return 'number';
    if (typeof native === 'boolean') return 'boolean';
    if (Array.isArray(native)) return 'array';
    if (typeof native === 'object') return 'object';
    return typeof native;
  }

  private classify(
    contractId: string | null,
    topics: ParsedTopic[],
    value: unknown,
    txHash: string | null,
    ledger: number | null,
  ): { pattern: SorobanEventPattern; normalized: ParsedSorobanEvent['normalized'] } {
    const name = this.eventName(topics);

    if (name === 'transfer') {
      const from = this.addressAt(topics, 1);
      const to = this.addressAt(topics, 2);
      const amount = this.amountFrom(value, topics, 3);
      return {
        pattern: 'sac.transfer',
        normalized: {
          pattern: 'sac.transfer',
          contractId,
          from,
          to,
          amount,
          txHash,
          ledger,
        } satisfies SacTransferEvent,
      };
    }

    if (name === 'mint') {
      const to = this.addressAt(topics, 1);
      const amount = this.amountFrom(value, topics, 2);
      return {
        pattern: 'sac.mint',
        normalized: {
          pattern: 'sac.mint',
          contractId,
          to,
          amount,
          txHash,
          ledger,
        } satisfies SacMintEvent,
      };
    }

    if (name === 'burn') {
      const from = this.addressAt(topics, 1);
      const amount = this.amountFrom(value, topics, 2);
      return {
        pattern: 'sac.burn',
        normalized: {
          pattern: 'sac.burn',
          contractId,
          from,
          amount,
          txHash,
          ledger,
        } satisfies SacBurnEvent,
      };
    }

    if (name === 'approve') {
      return {
        pattern: 'sac.approve',
        normalized: {
          pattern: 'sac.approve',
          contractId,
          topics: topics.map((t) => t.native),
          value,
          txHash,
          ledger,
        },
      };
    }

    return {
      pattern: 'unknown',
      normalized: {
        contractId,
        topics: topics.map((t) => t.native),
        value,
        txHash,
        ledger,
      },
    };
  }

  /** First topic is usually a Symbol event name for SAC / contract events. */
  private eventName(topics: ParsedTopic[]): string | null {
    if (topics.length === 0) return null;
    const n = topics[0].native;
    if (typeof n === 'string') return n.toLowerCase();
    return null;
  }

  private addressAt(topics: ParsedTopic[], index: number): string | null {
    if (index >= topics.length) return null;
    const n = topics[index].native;
    if (typeof n === 'string') return n;
    if (n && typeof n === 'object' && 'address' in (n as object)) {
      return String((n as { address: string }).address);
    }
    try {
      // Some SDK paths return Address-like objects
      if (n instanceof Address) return n.toString();
    } catch {
      /* ignore */
    }
    return n != null ? String(n) : null;
  }

  private amountFrom(value: unknown, topics: ParsedTopic[], topicIndex: number): string | null {
    const fromValue = this.stringifyAmount(value);
    if (fromValue !== null) return fromValue;
    if (topicIndex < topics.length) {
      return this.stringifyAmount(topics[topicIndex].native);
    }
    return null;
  }

  private stringifyAmount(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'string' && v.length > 0) return v;
    return null;
  }
}
