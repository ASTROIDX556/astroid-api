export class InvariantContractReadCache<T = unknown> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number = 300_000,
    private readonly maxSize: number = 250,
  ) {}

  buildKey(contractId: string, method: string, args: readonly unknown[] = []): string {
    return `${contractId.trim()}::${method.trim()}::${JSON.stringify(args)}`;
  }

  async getOrRead(
    contractId: string,
    method: string,
    args: readonly unknown[],
    reader: () => Promise<T>,
    now: number = Date.now(),
  ): Promise<T> {
    const key = this.buildKey(contractId, method, args);
    const cached = this.store.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const value = await reader();
    if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }
    this.store.set(key, { value, expiresAt: now + this.ttlMs });
    return value;
  }
}
