import { redactSensitiveText, sanitizeAuditPayload } from '../common/helpers/audit-sanitizer';

export const scrubString = redactSensitiveText;

export function scrubForLog(value: unknown): unknown {
  return sanitizeAuditPayload(value);
}
