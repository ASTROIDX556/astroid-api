import { createHash } from 'node:crypto';

export const AUDIT_CHAIN_GENESIS = 'GENESIS';

export interface CanonicalAuditEntry {
  id: string;
  actor: string | null;
  action: string;
  target: { entity: string; id: string | null };
  timestamp: Date;
  payload: {
    oldValue: unknown;
    newValue: unknown;
    ipAddress: string | null;
    device: string | null;
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${fields.join(',')}}`;
}

/** Hashes the fixed-order UTF-8 JSON fields followed by the predecessor hash. */
export function computeAuditEntryHash(entry: CanonicalAuditEntry, prevHash: string): string {
  const canonicalFields = stableJson([
    entry.id,
    entry.actor,
    entry.action,
    entry.target,
    entry.timestamp.toISOString(),
    entry.payload,
  ]);
  return createHash('sha256').update(canonicalFields + prevHash, 'utf8').digest('hex');
}
