import { resolve } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { ProtoGrpcType } from "../../protocol/generated/worker.js";
import type { WorkerClient } from "../../protocol/generated/tandoor/v1/Worker.js";
import type { MessageReceipt__Output } from "../../protocol/generated/tandoor/v1/MessageReceipt.js";
import type { GoogleLoginCancelResponse__Output } from "../../protocol/generated/tandoor/v1/GoogleLoginCancelResponse.js";

export type { WorkerClient, WorkerHandlers } from "../../protocol/generated/tandoor/v1/Worker.js";
export type { AgentMessage__Output as AgentMessage } from "../../protocol/generated/tandoor/v1/AgentMessage.js";
export type { AgentEvent, AgentEvent__Output as WireAgentEvent } from "../../protocol/generated/tandoor/v1/AgentEvent.js";
export type { TelegramAttachment__Output as TelegramAttachment } from "../../protocol/generated/tandoor/v1/TelegramAttachment.js";
export type { MessageReference__Output as MessageReference } from "../../protocol/generated/tandoor/v1/MessageReference.js";
export type { MessageReceipt__Output as MessageReceipt } from "../../protocol/generated/tandoor/v1/MessageReceipt.js";
export type { HealthResponse__Output as HealthResponse } from "../../protocol/generated/tandoor/v1/HealthResponse.js";
export type { IntegrationRequest__Output as IntegrationRequest } from "../../protocol/generated/tandoor/v1/IntegrationRequest.js";
export type { IntegrationRequestResolution__Output as IntegrationRequestResolution } from "../../protocol/generated/tandoor/v1/IntegrationRequestResolution.js";
export type { GoogleLoginStartResponse__Output as GoogleLoginStartResponse } from "../../protocol/generated/tandoor/v1/GoogleLoginStartResponse.js";
export type { GoogleLoginCancelResponse__Output as GoogleLoginCancelResponse } from "../../protocol/generated/tandoor/v1/GoogleLoginCancelResponse.js";

const conversationActions = ["session", "reset", "abort", "compact"] as const;
export type ConversationAction = (typeof conversationActions)[number];
const actions: ReadonlySet<string> = new Set(conversationActions);
export const isConversationAction = (value: string): value is ConversationAction => actions.has(value);

export type GoogleLoginCancelStatus = Exclude<GoogleLoginCancelResponse__Output["status"], "unspecified">;

export function isAdmitted({ status }: MessageReceipt__Output): boolean {
  return status === "queued" || status === "running" || status === "completed" || status === "unanswered";
}

/** Narrow the generated oneof once, rather than having feature code guess from optional fields. */
type OneOfEvent<T extends { event?: string }> = {
  [K in NonNullable<T["event"]> & keyof T]: { type: K; data: NonNullable<T[K]> };
}[NonNullable<T["event"]> & keyof T];

export function decodeEvent<T extends { event?: string }>(wire: T): OneOfEvent<T> {
  const type = wire.event;
  const data = type === undefined ? undefined : (wire as Record<string, unknown>)[type];
  if (data == null) throw new Error("The worker sent an incomplete event.");
  return { type, data } as OneOfEvent<T>;
}

export const WORKER_PROTOCOL_VERSION = "7";

const protoPath = resolve(process.cwd(), "packages/protocol/proto/tandoor/v1/worker.proto");
const definition = protoLoader.loadSync(protoPath, {
  longs: Number, enums: String, defaults: true, oneofs: true,
});
const { Worker } = (grpc.loadPackageDefinition(definition) as unknown as ProtoGrpcType).tandoor.v1;
const clientMetadata = new WeakMap<WorkerClient, grpc.Metadata>();

export function createWorkerClient(address: string, token: string): WorkerClient {
  const client = new Worker(address, grpc.credentials.createInsecure(), {
    "grpc.max_send_message_length": 32 * 1024 * 1024,
    "grpc.max_receive_message_length": 64 * 1024 * 1024,
  });
  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${token}`);
  clientMetadata.set(client, metadata);
  return client;
}

export function workerMetadata(client: WorkerClient): grpc.Metadata {
  const metadata = clientMetadata.get(client);
  if (!metadata) throw new Error("Missing worker authentication metadata.");
  return metadata;
}

export const workerServiceDefinition = Worker.service;
