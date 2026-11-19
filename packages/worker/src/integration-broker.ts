import { randomUUID } from "node:crypto";
import type {
  IntegrationRequest,
  IntegrationRequestResolution,
} from "../../shared/src/grpc.js";

type IntegrationOperation = Omit<IntegrationRequest, "requestId">;

interface PendingRequest {
  request: IntegrationRequest;
  sent: boolean;
  resolve(value: IntegrationRequestResolution): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Private worker-to-gateway request channel shared by credential-bound integrations. */
export class IntegrationRequestBroker {
  private sink: ((request: IntegrationRequest) => void) | undefined;
  private readonly pending = new Map<string, PendingRequest>();

  subscribe(sink: (request: IntegrationRequest) => void): () => void {
    this.sink = sink;
    for (const pending of this.pending.values()) this.send(pending);
    return () => {
      if (this.sink !== sink) return;
      this.sink = undefined;
      for (const [requestId, pending] of this.pending) {
        if (!pending.sent) continue;
        this.finish(requestId);
        pending.reject(new Error("The gateway disconnected before completing the integration request."));
      }
    };
  }

  request(
    operation: IntegrationOperation,
    signal?: AbortSignal,
  ): Promise<IntegrationRequestResolution> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Integration request cancelled.");
    }

    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finish(requestId);
        reject(new Error("The gateway did not complete the integration request in time."));
      }, 120_000);
      const pending: PendingRequest = {
        request: { ...operation, requestId },
        sent: false,
        resolve,
        reject,
        timer,
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal) {
        pending.onAbort = () => {
          this.finish(requestId);
          reject(signal.reason instanceof Error ? signal.reason : new Error("Integration request cancelled."));
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(requestId, pending);
      this.send(pending);
    });
  }

  /** Startup can resume a tool before the gateway stream attaches. Wait, rather than fail that durable call. */
  private send(pending: PendingRequest): void {
    if (!this.sink || pending.sent) return;
    pending.sent = true;
    try {
      this.sink(pending.request);
    } catch (error) {
      this.finish(pending.request.requestId);
      pending.reject(error instanceof Error ? error : new Error("Could not send the integration request to the gateway."));
    }
  }

  resolve(resolution: IntegrationRequestResolution): boolean {
    const pending = this.pending.get(resolution.requestId);
    if (!pending) return false;
    this.finish(resolution.requestId);
    pending.resolve(resolution);
    return true;
  }

  private finish(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    this.pending.delete(requestId);
  }
}
