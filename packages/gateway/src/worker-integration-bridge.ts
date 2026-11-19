import { workerMetadata, type IntegrationRequest, type WorkerClient } from "../../shared/src/grpc.js";
import type { WorkerScope } from "../../shared/src/scope.js";
import { validateIntegrationRequest } from "./integration-routing.js";
import { unary } from "./worker-client.js";

export type ServiceIntegration = (scope: WorkerScope, request: IntegrationRequest, signal: AbortSignal) => Promise<string>;

/** Authenticated service channel only; Telegram presentation and delivery have separate owners. */
export class WorkerIntegrationBridge {
  private readonly watchers = new Map<string, {
    worker: WorkerClient;
    stream?: ReturnType<WorkerClient["watchIntegrationRequests"]>;
    retry?: NodeJS.Timeout;
  }>();
  private stopping = false;

  constructor(private readonly services: ReadonlyMap<string, ServiceIntegration>) {}

  watchWorker(scope: WorkerScope, worker: WorkerClient): void {
    const key = `${scope.kind}:${scope.id}`;
    let entry = this.watchers.get(key);
    if (entry && entry.worker !== worker) {
      entry.stream?.cancel();
      if (entry.retry) clearTimeout(entry.retry);
      entry = undefined;
    }
    if (!entry) {
      entry = { worker };
      this.watchers.set(key, entry);
    }
    const watcher = entry;
    if (this.stopping || watcher.stream || watcher.retry) return;
    const stream = worker.watchIntegrationRequests({}, workerMetadata(worker));
    watcher.stream = stream;
    const restart = () => {
      if (this.watchers.get(key) !== watcher || watcher.stream !== stream) return;
      delete watcher.stream;
      if (this.stopping) return;
      watcher.retry = setTimeout(() => {
        delete watcher.retry;
        this.watchWorker(scope, worker);
      }, 1_000);
      watcher.retry.unref?.();
    };
    stream.on("data", (request: IntegrationRequest) => {
      void this.handle(scope, worker, request).catch((error: unknown) =>
        console.error("Integration request failed:", error instanceof Error ? error.message : error));
    });
    stream.on("end", restart);
    stream.on("error", restart);
  }

  private async handle(scope: WorkerScope, worker: WorkerClient, request: IntegrationRequest): Promise<void> {
    let resolution = { requestId: request.requestId, accepted: false, error: "", payloadJson: "" };
    try {
      validateIntegrationRequest(scope, request);
      const service = this.services.get(request.integrationId);
      if (!service) throw new Error("This service integration is unavailable.");
      resolution = { requestId: request.requestId, accepted: true, error: "",
        payloadJson: await service(scope, request, AbortSignal.timeout(100_000)) };
    } catch (error) {
      resolution.error = error instanceof Error ? error.message : "The integration request failed.";
    }
    await unary(worker, "resolveIntegrationRequest", resolution).catch(() => undefined);
  }

  stop(): void {
    this.stopping = true;
    for (const watcher of this.watchers.values()) {
      if (watcher.retry) clearTimeout(watcher.retry);
      watcher.stream?.cancel();
    }
    this.watchers.clear();
  }
}
