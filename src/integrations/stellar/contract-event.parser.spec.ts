import { describe, expect, it, vi } from 'vitest';
import { parseContractEventLogs, ContractEventParseLogger } from './contract-event.parser';
import { SorobanContractEvent } from './soroban.interface';

const validEvent: SorobanContractEvent = {
  type: 'contract',
  contractId: 'mock-contract-1',
  topic: ['transfer'],
  value: { from: 'GABC', to: 'GDEF', amount: '100' },
};

const otherValidEvent: SorobanContractEvent = {
  type: 'system',
  contractId: 'mock-contract-2',
  topic: ['token', 'burn'],
  value: null,
};

function buildLogger(): ContractEventParseLogger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

describe('parseContractEventLogs', () => {
  it('returns valid logs unchanged, in order, with the exact event type', () => {
    const logs = [validEvent, otherValidEvent];
    const parsed = parseContractEventLogs(logs);

    expect(parsed).toEqual(logs);
    expect(parsed[0]).toBe(validEvent); // same reference — behaviour preserved
    expect(parsed[1]).toBe(otherValidEvent);
  });

  it('returns an empty array for empty input', () => {
    expect(parseContractEventLogs([])).toEqual([]);
  });

  it('returns an empty array when the events field is missing entirely', () => {
    const logger = buildLogger();
    expect(parseContractEventLogs(undefined, logger)).toEqual([]);
    expect(parseContractEventLogs(null, logger)).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled(); // absent field is normal, not malformed
  });

  it('returns an empty array (with a warning) for a non-array events field', () => {
    const logger = buildLogger();
    expect(parseContractEventLogs({ corrupted: true } as unknown as never, logger)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('expected an array'));
  });

  it('skips invalid entries while continuing to parse valid ones in the batch', () => {
    const logger = buildLogger();
    const logs = [
      validEvent,
      null,
      'not-an-object',
      42,
      { ...validEvent },
      otherValidEvent,
    ];

    const parsed = parseContractEventLogs(logs, logger);

    expect(parsed).toEqual([validEvent, { ...validEvent }, otherValidEvent]);
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('warns and skips a log with a missing topic', () => {
    const logger = buildLogger();
    const { topic: _topic, ...withoutTopic } = validEvent;

    const parsed = parseContractEventLogs([withoutTopic, validEvent], logger);

    expect(parsed).toEqual([validEvent]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('index 0'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("'topic' must be an array"));
  });

  it('warns and skips logs with an empty or non-string topic', () => {
    const logger = buildLogger();
    const parsed = parseContractEventLogs(
      [
        { ...validEvent, topic: [] },
        { ...validEvent, topic: ['ok', 42] },
        { ...validEvent, topic: 'not-an-array' },
        validEvent,
      ],
      logger,
    );

    expect(parsed).toEqual([validEvent]);
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('warns and skips a log with a missing value payload', () => {
    const logger = buildLogger();
    const { value: _value, ...withoutValue } = validEvent;

    const parsed = parseContractEventLogs([withoutValue], logger);

    expect(parsed).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("missing 'value' payload"));
  });

  it('warns and skips logs with an empty type or contractId', () => {
    const logger = buildLogger();
    const parsed = parseContractEventLogs(
      [
        { ...validEvent, type: '' },
        { ...validEvent, contractId: '' },
        validEvent,
      ],
      logger,
    );

    expect(parsed).toEqual([validEvent]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('survives an entry whose property access throws (corrupted payload)', () => {
    const logger = buildLogger();
    const poisoned = new Proxy(
      {},
      {
        get() {
          throw new Error('boom: broken getter');
        },
      },
    );

    const parsed = parseContractEventLogs([poisoned, validEvent], logger);

    expect(parsed).toEqual([validEvent]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('index 0'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boom: broken getter'));
  });

  it('works without a logger (warnings are optional)', () => {
    expect(() => parseContractEventLogs([null, undefined, validEvent])).not.toThrow();
    expect(parseContractEventLogs([null, undefined, validEvent])).toEqual([validEvent]);
  });
});
