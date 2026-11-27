import type { Context } from "grammy";
import type { TelegramAttachment } from "../../shared/src/grpc.js";
import { conversationKey, type TelegramMessageIdentity } from "../../shared/src/scope.js";
import { mediaDescription, messageText, parseCommand, senderName, telegramAttachments, telegramIdentity } from "./telegram-base.js";
import type { TelegramUI } from "./telegram-ui.js";
import type { TelegramGoogleAuth } from "./telegram-google-auth.js";
import type { TelegramCommands } from "./telegram-commands.js";
import type { TelegramInbox } from "./telegram-inbox.js";

export class TelegramReceiptWriteFailed extends Error {}

/** Decode transport input, route commands, then await durable admission. No execution queue lives here. */
export class TelegramMessageHandler {
  constructor(private readonly options: {
    ui: TelegramUI;
    token: string;
    google: TelegramGoogleAuth;
    commands: TelegramCommands;
    inbox: TelegramInbox;
  }) {}

  async handleMessageUpdate(ctx: Context): Promise<void> {
    const { ui, google, inbox, commands } = this.options;
    const identity = telegramIdentity(ctx);
    if (!identity || !ctx.message || !ctx.from || !ui.isAllowed(identity)) return;
    if ("forum_topic_created" in ctx.message) return;
    if (await google.handleGoogleLoginReply(ctx, identity)) return;
    const rawText = messageText(ctx);
    let attachments: TelegramAttachment[] = [];
    let notice = "";
    try { attachments = await telegramAttachments(ctx, this.options.token); }
    catch (error) { notice = `Attachment unavailable: ${error instanceof Error ? error.message : "download failed."}`; }
    const command = !attachments.length && !notice ? parseCommand(rawText, ui.bot.botInfo.username) : undefined;
    if (command && await commands.handle(ctx, identity, command)) return;
    try {
      await inbox.accept({
        channel: "telegram",
        requestId: `telegram:${identity.chatId}:${ctx.message.message_id}`,
        conversationKey: conversationKey(identity),
        text: [rawText, notice].filter(Boolean).join("\n") || (!attachments.length ? `[Sent a ${mediaDescription(ctx)} Telegram message.]` : ""),
        attachments, senderId: String(identity.senderId), senderName: senderName(ctx),
        chatId: String(identity.chatId),
        timestampMs: ctx.message.date * 1000,
      }, identity);
    } catch (error) {
      // The poller must not acknowledge an update whose local receipt was not confirmed.
      throw new TelegramReceiptWriteFailed("Could not durably accept the Telegram message.", { cause: error });
    }
  }
}
