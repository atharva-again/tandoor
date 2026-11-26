import { decodeEvent, workerMetadata, type MessageReference, type WireAgentEvent, type WorkerClient } from "../../shared/src/grpc.js";
import type { CallOptions, ClientUnaryCall, Metadata, requestCallback } from "@grpc/grpc-js";
import { RESPONSE_LIMITS, storeAttachment, type AgentResponse } from "../../shared/src/agent-response.js";
import type { WorkerScope } from "../../shared/src/scope.js";

export type ConnectWorker = (scope: WorkerScope) => Promise<WorkerClient>;

type UnaryMethod = {
  [K in keyof WorkerClient]: WorkerClient[K] extends (...args: never[]) => ClientUnaryCall ? K : never;
}[keyof WorkerClient];
type Request<K extends UnaryMethod> = Parameters<WorkerClient[K]>[0];
type Response<K extends UnaryMethod> = Parameters<WorkerClient[K]>[1] extends requestCallback<infer T> ? T : never;

export function unary<K extends UnaryMethod>(
  worker: WorkerClient,
  method: K,
  request: Request<K>,
  { signal, timeoutMs = 120_000 }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Response<K>> {
  // The generated overloads all share this gRPC call shape. Infer the request
  // and response from their short overload and use the deadline-aware overload.
  const call = worker[method] as (
    request: Request<K>, metadata: Metadata, options: CallOptions, callback: requestCallback<Response<K>>,
  ) => ClientUnaryCall;
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const pending = call.call(worker, request, workerMetadata(worker), { deadline: Date.now() + timeoutMs }, (error, response) => {
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error);
      else if (response === undefined) reject(new Error("The worker returned no response."));
      else resolve(response);
    });
    const cancel = () => pending.cancel();
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

/** One response decoder for interactive replies and scheduled work. Cancelling observation never cancels work. */
export async function collectResponse(
  worker: WorkerClient,
  reference: MessageReference,
  signal?: AbortSignal,
  onTextUpdate: (text: string) => void = () => {},
): Promise<AgentResponse> {
  const stream = worker.watchMessage(reference, workerMetadata(worker));
  const cancel = () => stream.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) stream.cancel();
  const response: AgentResponse = { text: "", attachments: [] };
  let completed = false;
  let totalBytes = 0;
  try {
    for await (const wire of stream as AsyncIterable<WireAgentEvent>) {
      if (wire.requestId !== reference.requestId || completed) throw new Error("Unexpected worker response event.");
      const event = decodeEvent(wire);
      switch (event.type) {
        case "started":
          break;
        case "textUpdate":
          onTextUpdate(event.data.text);
          break;
        case "attachment": {
          const bytes = event.data.data.byteLength;
          totalBytes += bytes;
          if (
            bytes > RESPONSE_LIMITS.fileBytes || totalBytes > RESPONSE_LIMITS.totalBytes ||
            response.attachments.length >= RESPONSE_LIMITS.fileCount
          ) throw new Error("The response exceeds Telegram's file delivery limits.");
          response.attachments.push(storeAttachment(event.data));
          break;
        }
        case "failed":
          // Agent failures are final answers, not transport failures to retry indefinitely.
          return { text: `Tandoor: ${event.data.message}`, attachments: [] };
        case "completed":
          completed = true;
          response.text = event.data.text;
          break;
      }
    }
    if (!completed) throw new Error("Worker closed the response without a final result.");
    return response;
  } finally {
    signal?.removeEventListener("abort", cancel);
    stream.cancel();
  }
}
