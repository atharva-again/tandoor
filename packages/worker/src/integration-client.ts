import type { IntegrationRequestBroker } from "./integration-broker.js";
import type { WorkerScope } from "../../shared/src/scope.js";
import type { TelegramRunContext } from "./actor-context.js";

/** Gateway-owned services use the persisted sender/destination of the active run. */
export class GatewayIntegrationClient {
  constructor(
    private readonly scope: WorkerScope,
    private readonly broker: IntegrationRequestBroker,
  ) {}

  async execute<T>(
    telegram: TelegramRunContext,
    integrationId: string,
    operation: string,
    payload: unknown,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    if (telegram.actorId !== this.scope.id) {
      throw new Error("This worker cannot route requests for another Telegram user.");
    }
    const payloadJson = JSON.stringify(payload);
    if (payloadJson === undefined) throw new Error("The integration payload is not JSON serializable.");
    const resolution = await this.broker.request({
      conversationKey: telegram.conversationKey,
      actorId: telegram.actorId,
      integrationId,
      operation,
      payloadJson,
      targetScope: "service",
    }, signal);
    if (!resolution.accepted) throw new Error(resolution.error || "The integration request was rejected.");
    let value: unknown;
    try {
      value = JSON.parse(resolution.payloadJson);
    } catch {
      throw new Error("The integration returned invalid JSON.");
    }
    return parse(value);
  }
}
