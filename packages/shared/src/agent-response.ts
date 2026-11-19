import type { TelegramAttachment } from "./grpc.js";

export const RESPONSE_LIMITS = {
  fileBytes: 50 * 1024 * 1024,
  totalBytes: 100 * 1024 * 1024,
  fileCount: 5,
} as const;

/** JSON-safe snapshots: delivery retries never reread mutable workspace files. */
export type ResponseAttachment = { filename: string; mimeType: string; data: string };
export type AgentResponse = { text: string; attachments: ResponseAttachment[] };

export function storeAttachment(file: TelegramAttachment): ResponseAttachment {
  return { filename: file.filename, mimeType: file.mimeType, data: Buffer.from(file.data).toString("base64") };
}

export function restoreAttachment(file: ResponseAttachment): TelegramAttachment {
  return { ...file, data: Buffer.from(file.data, "base64") };
}

export function isAgentResponse(value: unknown): value is AgentResponse {
  if (typeof value !== "object" || value === null || !("text" in value) ||
    typeof value.text !== "string" || !("attachments" in value) || !Array.isArray(value.attachments)) return false;
  return value.attachments.every((file: unknown) =>
    typeof file === "object" && file !== null &&
    "filename" in file && typeof file.filename === "string" &&
    "mimeType" in file && typeof file.mimeType === "string" &&
    "data" in file && typeof file.data === "string");
}
