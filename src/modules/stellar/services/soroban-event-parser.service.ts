import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { xdr, scValToNative, Address } from '@stellar/stellar-sdk';
import { DomainEventName } from '../../../events/event-names';

export interface RawSorobanEvent {
  type?: string;
  ledger?: number;
  ledgerClosedAt?: string;
  contractId?: string;
  id?: string;
  pagingToken?: string;
  topic?: string[];
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
  pattern: SorobanEventPattern;
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

export const SOROBAN_EVENT_PARSED = 'stellar.soroban_event_parsed';

@Injectable()
export class SorobanEventParserService {
  private readonly logger = new Logger(SorobanEventParserService.name);

  constructor(private readonly emitter: EventEmitter2) {}

  parseEvents(rawEvents: RawSorobanEvent[]): ParsedSorobanEvent[] {
    if (!Array.isArray(rawEvents)) {
      this.logger.warn('parseEvents called with non-array input');
      return [];
    }
    return rawEvents.map((raw) => this.parseOne(raw));
  }

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
          'EventEmitter failed for contract=' +
            String(event.contractId) +
            ': ' +
            (err as Error).message,
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
        'Failed to parse Soroban event contractId=' +
          String(raw.contractId ?? '?') +
          ' tx=' +
          String(raw.txHash ?? '?') +
          ': ' +
          (err as Error).message,
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
          rawBase64: rawBase64,
          native: native,
          kind: this.topicKind(native),
        });
      } catch (err) {
        this.logger.warn(
          'Unparseable topic[' + String(i) + ']: ' + (err as Error).message,
        );
        out.push({
          index: i,
          rawBase64: rawBase64,
          native: null,
          kind: 'error',
        });
      }
    }
    return out;
  }

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
          contractId: contractId,
          from: from,
          to: to,
          amount: amount,
          txHash: txHash,
          ledger: ledger,
        },
      };
    }

    if (name === 'mint') {
      const to = this.addressAt(topics, 1);
      const amount = this.amountFrom(value, topics, 2);
      return {
        pattern: 'sac.mint',
        normalized: {
          pattern: 'sac.mint',
          contractId: contractId,
          to: to,
          amount: amount,
          txHash: txHash,
          ledger: ledger,
        },
      };
    }

    if (name === 'burn') {
      const from = this.addressAt(topics, 1);
      const amount = this.amountFrom(value, topics, 2);
      return {
        pattern: 'sac.burn',
        normalized: {
          pattern: 'sac.burn',
          contractId: contractId,
          from: from,
          amount: amount,
          txHash: txHash,
          ledger: ledger,
        },
      };
    }

    if (name === 'approve') {
      return {
        pattern: 'sac.approve',
        normalized: {
          pattern: 'sac.approve',
          contractId: contractId,
          topics: topics.map((t) => t.native),
          value: value,
          txHash: txHash,
          ledger: ledger,
        },
      };
    }

    return {
      pattern: 'unknown',
      normalized: {
        contractId: contractId,
        topics: topics.map((t) => t.native),
        value: value,
        txHash: txHash,
        ledger: ledger,
      },
    };
  }

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
      if (n instanceof Address) return n.toString();
    } catch {
      // ignore
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
