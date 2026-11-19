import type { Context } from "grammy";
import type { ModelOption, TelegramAttachment } from "../../shared/src/grpc.js";
import type { TelegramMessageIdentity } from "../../shared/src/scope.js";

export type InlineKeyboardButton =
  | { text: string; callback_data: string; url?: never; copy_text?: never }
  | { text: string; url: string; callback_data?: never; copy_text?: never }
  | { text: string; copy_text: { text: string }; callback_data?: never; url?: never };
export interface InlineKeyboardMarkup { inline_keyboard: InlineKeyboardButton[][] }

export function telegramIdentity(ctx: Context): TelegramMessageIdentity | undefined {
  const message = ctx.message;
  if (!message || ctx.from?.id === undefined || message.chat.type !== "private") return undefined;
  const threadId = "message_thread_id" in message ? message.message_thread_id : undefined;
  return { chatId: message.chat.id, senderId: ctx.from.id, chatType: "private", ...(threadId === undefined ? {} : { threadId }) };
}

export function callbackIdentity(ctx: Context) {
  const query = ctx.callbackQuery;
  if (!query || !("message" in query) || !query.message || query.message.chat.type !== "private") return undefined;
  const message = query.message;
  const threadId = "message_thread_id" in message ? message.message_thread_id : undefined;
  const identity: TelegramMessageIdentity = {
    chatId: message.chat.id, senderId: query.from.id, chatType: "private", ...(threadId === undefined ? {} : { threadId }),
  };
  return { identity, messageId: message.message_id };
}

export function modelReference(model: Pick<ModelOption, "provider" | "modelId">): string {
  return `${model.provider}/${model.modelId}`;
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = { openai: "OpenAI", "openai-codex": "OpenAI Codex", xai: "xAI (Grok/X)" };
export function providerDisplayName(providerId: string): string { return PROVIDER_NAMES[providerId] ?? providerId; }

export function messageText(ctx: Context): string {
  const message = ctx.message;
  if (!message) return "";
  return ("text" in message ? message.text : undefined) ?? ("caption" in message ? message.caption : undefined) ?? "";
}

export function isGoogleCallbackUrl(value: string): boolean {
  if (value.length > 16_384) return false;
  try {
    const url = new URL(value);
    const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || localHttp) && !url.username && !url.password &&
      (url.searchParams.has("code") || url.searchParams.has("error")) && url.searchParams.has("state");
  } catch { return false; }
}

export function mediaDescription(ctx: Context): string {
  const message = ctx.message;
  return message ? ["photo", "document", "video", "audio", "voice", "animation", "sticker", "video_note"]
    .find((kind) => kind in message) ?? "non-text" : "message";
}

async function downloadAttachment(
  ctx: Context, token: string, fileId: string, filename: string, mimeType: string, fileSize?: number,
): Promise<TelegramAttachment> {
  const limit = 20 * 1024 * 1024;
  if (fileSize !== undefined && fileSize > limit) throw new Error("Telegram attachments larger than 20 MB are not supported.");
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram provided no attachment download path.");
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
  } catch { throw new Error("Could not download the Telegram attachment."); }
  if (!response.ok) throw new Error("Telegram could not provide the attachment.");
  const data = Buffer.from(await response.arrayBuffer());
  if (data.byteLength > limit) throw new Error("Telegram attachments larger than 20 MB are not supported.");
  return { filename, mimeType, data };
}

export async function telegramAttachments(ctx: Context, token: string): Promise<TelegramAttachment[]> {
  const message = ctx.message;
  if (!message) return [];
  if ("photo" in message && message.photo?.length) {
    const photo = message.photo.reduce((largest, current) => current.width * current.height > largest.width * largest.height ? current : largest);
    return [await downloadAttachment(ctx, token, photo.file_id, `photo-${message.message_id}.jpg`, "image/jpeg", photo.file_size)];
  }
  if ("document" in message && message.document) {
    const file = message.document;
    return [await downloadAttachment(ctx, token, file.file_id, file.file_name || `document-${message.message_id}`, file.mime_type || "application/octet-stream", file.file_size)];
  }
  return [];
}

export function parseCommand(text: string, username: string) {
  const match = text.trim().match(/^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  if (!match || (match[2] && match[2].toLowerCase() !== username.toLowerCase())) return undefined;
  return { name: match[1]!.toLowerCase(), args: match[3]?.trim() ?? "" };
}

export function senderName(ctx: Context): string {
  const from = ctx.from;
  return from ? [from.first_name, from.last_name].filter(Boolean).join(" ").trim() || from.username || String(from.id) : "Unknown";
}

export function isGoogleAccountEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function googleAccountButtonLabel(email: string): string {
  const characters = Array.from(email);
  return characters.length <= 64 ? email : `${characters.slice(0, 61).join("")}…`;
}

export function safeTelegramFilename(value: string): string {
  const name = value.replace(/\\/g, "/").split("/").pop() ?? "";
  return name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120) || "attachment.bin";
}
