import { SorobanContractEvent } from './soroban.interface';

/**
 * Defensive parsing of contract event logs returned by the Soroban RPC.
 *
 * A single malformed entry — a missing `topic` array, a null payload, a
 * corrupted object whose property access throws — must never abort batch
 * processing of the remaining valid events. Every entry is validated inside
 * its own try/catch; invalid entries are skipped with a warning so callers
 * keep a clean `SorobanContractEvent[]` and valid logs behave exactly as
 * before.
 */

/** Minimal logger shape so callers (and tests) can inject any logger. */
export interface ContractEventParseLogger {
  warn(message: string): void;
}

/**
 * Validates one raw log entry.
 *
 * @returns `null` when the entry is a well-formed event, otherwise a
 *          human-readable reason describing what is wrong with it.
 */
function validateEventLog(log: unknown): string | null {
  if (log === null || typeof log !== 'object' || Array.isArray(log)) {
    const received = log === null ? 'null' : Array.isArray(log) ? 'an array' : typeof log;
    return `expected an event object, received ${received}`;
  }

  const candidate = log as Partial<SorobanContractEvent> & Record<string, unknown>;

  if (typeof candidate.type !== 'string' || candidate.type.length === 0) {
    return "'type' must be a non-empty string";
  }
  if (typeof candidate.contractId !== 'string' || candidate.contractId.length === 0) {
    return "'contractId' must be a non-empty string";
  }
  if (!Array.isArray(candidate.topic)) {
    return "'topic' must be an array of strings";
  }
  if (candidate.topic.length === 0) {
    return "'topic' must not be empty";
  }
  if (!candidate.topic.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    return "'topic' entries must be non-empty strings";
  }
  if (!('value' in candidate)) {
    return "missing 'value' payload";
  }
  return null;
}

/**
 * Parses a batch of raw contract event logs, keeping only well-formed
 * entries.
 *
 * - Non-array input (e.g. an RPC response missing `events`) yields `[]`.
 * - Each malformed entry is skipped individually with a `warn` so one bad
 *   log never aborts parsing of the valid ones that follow.
 * - Property access itself is wrapped in try/catch, so even corrupted
 *   objects (throwing getters/proxies) degrade to a warning.
 * - Valid entries are returned unchanged, in order, with the exact
 *   {@link SorobanContractEvent} type.
 *
 * @param logs   - Raw event array from a simulation result (possibly malformed).
 * @param logger - Optional logger that receives one warning per skipped entry.
 */
export function parseContractEventLogs(
  logs: readonly unknown[] | null | undefined,
  logger?: ContractEventParseLogger,
): SorobanContractEvent[] {
  if (!Array.isArray(logs)) {
    if (logs !== undefined && logs !== null) {
      logger?.warn(
        `Skipping contract event logs: expected an array, received ${typeof logs}`,
      );
    }
    return [];
  }

  const parsed: SorobanContractEvent[] = [];
  logs.forEach((log, index) => {
    let reason: string | null;
    try {
      reason = validateEventLog(log);
    } catch (error) {
      // A corrupted entry can throw on property access; skip it like any
      // other malformed log instead of failing the whole batch.
      reason = `reading the entry threw: ${(error as Error).message}`;
    }

    if (reason !== null) {
      logger?.warn(`Skipping malformed contract event log at index ${index}: ${reason}`);
      return;
    }

    parsed.push(log as SorobanContractEvent);
  });
  return parsed;
}
