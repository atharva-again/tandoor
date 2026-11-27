import type { Context } from "grammy";
import type { TelegramMessageIdentity } from "../../shared/src/scope.js";

export function previewText(text: string): string {
  return text.replace(/(?<!\S)MEDIA:[^\n]*/g, "").trimEnd();
}

export function splitTelegramText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 4096) {
    let splitAt = remaining.lastIndexOf("\n", 3900);
    if (splitAt < 1950) splitAt = 3900;
    if (remaining.charCodeAt(splitAt - 1) >= 0xd800 && remaining.charCodeAt(splitAt - 1) <= 0xdbff &&
      remaining.charCodeAt(splitAt) >= 0xdc00 && remaining.charCodeAt(splitAt) <= 0xdfff) splitAt--;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length || !chunks.length) chunks.push(remaining);
  return chunks;
}

export async function sendRichMarkdownMessage(ctx: Context, identity: TelegramMessageIdentity, text: string): Promise<void> {
  for (const chunk of splitTelegramText(text)) {
    try { await ctx.api.sendRichMessage(identity.chatId, { markdown: chunk }, {}); }
    catch { await ctx.api.sendMessage(identity.chatId, chunk, {}); }
  }
}
