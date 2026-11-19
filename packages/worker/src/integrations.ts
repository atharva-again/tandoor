export interface IntegrationAdapter {
  readonly id: string;
  execute(operation: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** Per-worker integration adapters; each adapter operates only on this worker's own credentials and files. */
export class IntegrationRegistry {
  private readonly adapters = new Map<string, IntegrationAdapter>();

  register(adapter: IntegrationAdapter): void {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(adapter.id)) {
      throw new Error(`Invalid integration id: ${adapter.id}`);
    }
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Integration already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  async execute(
    integrationId: string,
    operation: string,
    payloadJson: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const adapter = this.adapters.get(integrationId);
    if (!adapter) throw new Error(`Integration is not available in this worker: ${integrationId}`);
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(operation)) {
      throw new Error(`Invalid integration operation: ${operation}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(payloadJson);
    } catch {
      throw new Error("The integration request payload is not valid JSON.");
    }
    const result = await adapter.execute(operation, payload, signal);
    const serialized = JSON.stringify(result);
    if (serialized === undefined) throw new Error("The integration returned no JSON result.");
    return serialized;
  }
}
