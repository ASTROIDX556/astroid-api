import { AsyncLocalStorage } from 'async_hooks';

export interface TraceContextData {
  traceId: string;
  agentId?: string;
  organizationId?: string;
  userId?: string;
  [key: string]: unknown;
}

export class TraceContext {
  private static readonly storage = new AsyncLocalStorage<TraceContextData>();

  static run<R>(data: TraceContextData, fn: () => R): R {
    return this.storage.run(data, fn);
  }

  static get(): TraceContextData | undefined {
    return this.storage.getStore();
  }

  static getTraceId(): string | undefined {
    return this.storage.getStore()?.traceId;
  }

  static getAgentId(): string | undefined {
    return this.storage.getStore()?.agentId;
  }

  static getOrganizationId(): string | undefined {
    return this.storage.getStore()?.organizationId;
  }

  static set(data: Partial<TraceContextData>): void {
    const store = this.storage.getStore();
    if (store) {
      Object.assign(store, data);
    }
  }
}
