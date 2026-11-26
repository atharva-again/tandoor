import type { Context } from "grammy";
import type { TelegramAttachment } from "../../shared/src/grpc.js";
import { conversationKey, type TelegramMessageIdentity } from "../../shared/src/scope.js";
import { mediaDescription, messageText, parseCommand, senderName, telegramAttachments, telegramIdentity } from "./telegram-base.js";
import type { TelegramUI } from "./telegram-ui.js";
import type { TelegramProviderAuth } from "./telegram-provider-auth.js";
import type { TelegramGoogleAuth } from "./telegram-google-auth.js";
import type { TelegramCommands } from "./telegram-commands.js";
import type { TelegramInbox } from "./telegram-inbox.js";
import { createdTelegramTopic } from "./telegram-topics.js";

export class TelegramReceiptWriteFailed extends Error {}

/** Decode transport input, route commands, then await durable admission. No execution queue lives here. */
export class TelegramMessageHandler {
  private readonly implicitTopics = new Set<string>();
  private readonly pendingTitles = new Map<string, string>();

  constructor(private readonly options: {
    ui: TelegramUI;
    token: string;
    providers: TelegramProviderAuth;
    google: TelegramGoogleAuth;
    commands: TelegramCommands;
    inbox: TelegramInbox;
  }) {}

  async handleMessageUpdate(ctx: Context): Promise<void> {
    const { ui, providers, google, inbox, commands } = this.options;
    const identity = telegramIdentity(ctx);
    if (!identity || !ctx.message || !ctx.from || !ui.isAllowed(identity)) return;
    const topic = createdTelegramTopic(ctx);
    if (topic) {
      if (topic.implicit) this.implicitTopics.add(`${identity.chatId}:${topic.threadId}`);
      return;
    }
    if (await google.handleGoogleLoginReply(ctx, identity) || await providers.handleOAuthReply(ctx, identity)) return;
    const rawText = messageText(ctx);
    let attachments: TelegramAttachment[] = [];
    let notice = "";
    try { attachments = await telegramAttachments(ctx, this.options.token); }
    catch (error) { notice = `Attachment unavailable: ${error instanceof Error ? error.message : "download failed."}`; }
    const command = !attachments.length && !notice ? parseCommand(rawText, ui.bot.botInfo.username) : undefined;
    await this.renameTopic(identity, rawText, attachments, Boolean(command || notice), ctx);
    if (command && await commands.handle(ctx, identity, command)) return;
    try {
      await inbox.accept({
        channel: "telegram",
        requestId: `telegram:${identity.chatId}:${ctx.message.message_id}`,
        conversationKey: conversationKey(identity),
        text: [rawText, notice].filter(Boolean).join("\n") || (!attachments.length ? `[Sent a ${mediaDescription(ctx)} Telegram message.]` : ""),
        attachments, senderId: String(identity.senderId), senderName: senderName(ctx),
        chatId: String(identity.chatId), threadId: identity.threadId === undefined ? "" : String(identity.threadId),
        timestampMs: ctx.message.date * 1000,
      }, identity);
    } catch (error) {
      // The poller must not acknowledge an update whose local receipt was not confirmed.
      throw new TelegramReceiptWriteFailed("Could not durably accept the Telegram message.", { cause: error });
    }
  }

  private async renameTopic(
    identity: TelegramMessageIdentity, text: string, attachments: TelegramAttachment[], skip: boolean, ctx: Context,
  ): Promise<void> {
    if (identity.threadId === undefined || skip) return;
    const key = `${identity.chatId}:${identity.threadId}`;
    let title = this.pendingTitles.get(key);
    if (!title && this.implicitTopics.has(key)) {
      const source = text.trim() || attachments[0]?.filename || mediaDescription(ctx);
      title = Array.from((source.split(/\r?\n/, 1)[0] ?? source).replace(/\s+/g, " ").trim()).slice(0, 64).join("");
      if (!title) return;
      this.implicitTopics.delete(key);
      this.pendingTitles.set(key, title);
    }
    if (!title) return;
    try {
      await this.options.ui.bot.api.editForumTopic(identity.chatId, identity.threadId, { name: title });
      this.pendingTitles.delete(key);
    } catch (error) {
      console.warn("Could not rename Telegram topic:", error instanceof Error ? error.message : error);
    }
  }
}
