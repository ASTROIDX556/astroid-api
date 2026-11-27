/**
 * Deterministic dead-letter job id for one failed source job.
 *
 * The same terminal failure can be observed twice — by the worker that gave up
 * on the delivery and by the global queue failure listener — so the dead-letter
 * entry is keyed on the source queue and job id. BullMQ ignores an `add` whose
 * id already exists, which keeps a single dead-letter entry per failed job and
 * makes the routing idempotent.
 *
 * Both parts are URI-encoded and joined with `|` (never emitted unescaped by
 * `encodeURIComponent`) so the id stays unambiguous, and `:` is avoided because
 * BullMQ rejects it in custom job ids.
 */
export function buildDeadLetterJobId(queue: string, jobId: string): string {
  return `dlq-${encodeURIComponent(queue)}|${encodeURIComponent(jobId)}`;
}
