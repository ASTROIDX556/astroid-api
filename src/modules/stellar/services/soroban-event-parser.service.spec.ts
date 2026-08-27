import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { nativeToScVal } from '@stellar/stellar-sdk';
import {
  SorobanEventParserService,
  SOROBAN_EVENT_PARSED,
  RawSorobanEvent,
} from './soroban-event-parser.service';
import { DomainEventName } from '../../../events/event-names';

function scValToBase64(value: unknown): string {
  const scVal = nativeToScVal(value as never);
  return scVal.toXDR('base64');
}

function makeTransferRaw(overrides: Partial<RawSorobanEvent> = {}): RawSorobanEvent {
  return {
    type: 'contract',
    ledger: 1_234_567,
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
    txHash: 'abc123def456',
    topic: [
      scValToBase64('transfer'),
      scValToBase64('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
      scValToBase64('GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'),
    ],
    value: scValToBase64(1_000_000n),
    ...overrides,
  };
}

describe('SorobanEventParserService', () => {
  let emitter: EventEmitter2;
  let service: SorobanEventParserService;

  beforeEach(() => {
    emitter = new EventEmitter2();
    service = new SorobanEventParserService(emitter);
  });

  it('parses SAC transfer topics and value into typed normalized payload', () => {
    const raw = makeTransferRaw();
    const [parsed] = service.parseEvents([raw]);

    expect(parsed.pattern).toBe('sac.transfer');
    expect(parsed.contractId).toBe(raw.contractId);
    expect(parsed.txHash).toBe('abc123def456');
    expect(parsed.topics[0].native).toBe('transfer');
    expect(parsed.normalized).toMatchObject({
      pattern: 'sac.transfer',
      amount: '1000000',
    });
    expect((parsed.normalized as { from: string }).from).toBeTruthy();
    expect((parsed.normalized as { to: string }).to).toBeTruthy();
  });

  it('maps mint and burn patterns', () => {
    const mint: RawSorobanEvent = {
      contractId: 'CMint',
      topic: [scValToBase64('mint'), scValToBase64('GTO')],
      value: scValToBase64(50n),
      txHash: 'mint-tx',
      ledger: 10,
    };
    const burn: RawSorobanEvent = {
      contractId: 'CBurn',
      topic: [scValToBase64('burn'), scValToBase64('GFROM')],
      value: scValToBase64(25n),
      txHash: 'burn-tx',
      ledger: 11,
    };

    const [m, b] = service.parseEvents([mint, burn]);
    expect(m.pattern).toBe('sac.mint');
    expect(m.normalized).toMatchObject({ pattern: 'sac.mint', amount: '50' });
    expect(b.pattern).toBe('sac.burn');
    expect(b.normalized).toMatchObject({ pattern: 'sac.burn', amount: '25' });
  });

  it('does not throw on malformed XDR; marks unparseable / logs path', () => {
    const bad: RawSorobanEvent = {
      contractId: 'CBad',
      topic: ['not-valid-base64-xdr!!!'],
      value: '%%%',
      txHash: 'bad-tx',
    };

    expect(() => service.parseEvents([bad])).not.toThrow();
    const [parsed] = service.parseEvents([bad]);
    expect(parsed.contractId).toBe('CBad');
    expect(parsed.txHash).toBe('bad-tx');
  });

  it('emits SOROBAN_EVENT_PARSED and TransactionConfirmed for transfers', async () => {
    const parsedSpy = vi.fn();
    const confirmedSpy = vi.fn();
    emitter.on(SOROBAN_EVENT_PARSED, parsedSpy);
    emitter.on(DomainEventName.TransactionConfirmed, confirmedSpy);

    const raw = makeTransferRaw();
    const result = await service.ingestAndEmit([raw]);

    expect(result).toHaveLength(1);
    expect(result[0].pattern).toBe('sac.transfer');
    expect(parsedSpy).toHaveBeenCalledTimes(1);
    expect(confirmedSpy).toHaveBeenCalledTimes(1);
    expect(confirmedSpy.mock.calls[0][0]).toMatchObject({
      source: 'soroban',
      pattern: 'sac.transfer',
    });
  });

  it('skips emit for unparseable events but continues the batch', async () => {
    const spy = vi.fn();
    emitter.on(SOROBAN_EVENT_PARSED, spy);

    const good = makeTransferRaw();
    const bad: RawSorobanEvent = {
      contractId: 'CBad',
      topic: ['!!!!'],
      value: '!!!!',
    };

    const result = await service.ingestAndEmit([bad, good]);
    expect(result).toHaveLength(2);
    expect(spy).toHaveBeenCalled();
  });

  it('returns empty array for non-array input', () => {
    expect(service.parseEvents(null as unknown as RawSorobanEvent[])).toEqual([]);
  });

  it('classifies unknown symbol as unknown pattern', () => {
    const raw: RawSorobanEvent = {
      contractId: 'C1',
      topic: [scValToBase64('custom_event')],
      value: scValToBase64(1n),
    };
    const [parsed] = service.parseEvents([raw]);
    expect(parsed.pattern).toBe('unknown');
    expect(parsed.topics[0].native).toBe('custom_event');
  });
});
