import { Bot, type Context } from "grammy";
import { randomUUID } from "node:crypto";
import type { TelegramMessageIdentity } from "../../shared/src/scope.js";
import { callbackIdentity, type InlineKeyboardMarkup } from "./telegram-base.js";

export type TelegramAction = (identity: TelegramMessageIdentity, messageId: number) => Promise<void>;

/** Transport primitives only. Feature state and callback dispatch stay with their owners. */
export class TelegramUI {
  readonly bot: Bot;
  private readonly actions = new Map<string, TelegramAction>();

  constructor(token: string, private readonly allowedUserIds: ReadonlySet<string>) {
    this.bot = new Bot(token);
  }

  isAllowed(identity: TelegramMessageIdentity): boolean {
    return identity.chatType === "private" && this.allowedUserIds.has(String(identity.senderId));
  }

  pickerButton(text: string, action: TelegramAction) {
    if (this.actions.size >= 1000) this.actions.delete(this.actions.keys().next().value!);
    const id = randomUUID().slice(0, 16);
    this.actions.set(id, action);
    return { text, callback_data: `td:${id}` };
  }

  async handleCallback(ctx: Context): Promise<void> {
    const callback = callbackIdentity(ctx);
    const data = ctx.callbackQuery?.data ?? "";
    const action = this.actions.get(data.startsWith("td:") ? data.slice(3) : "");
    await ctx.answerCallbackQuery(action ? undefined : { text: "This button has expired. Open the command again." });
    if (!callback || !action || !this.isAllowed(callback.identity)) return;
    try { await action(callback.identity, callback.messageId); }
    catch (error) {
      await this.reply(ctx, callback.identity, `Tandoor: ${error instanceof Error ? error.message : "The action failed."}`);
    }
  }

  async reply(ctx: Context, identity: TelegramMessageIdentity, text: string): Promise<void> {
    await ctx.api.sendMessage(identity.chatId, text, {
      ...(identity.threadId === undefined ? {} : { message_thread_id: identity.threadId }),
    });
  }

  buttonRows<T>(buttons: T[], columns = 2): T[][] {
    const rows: T[][] = [];
    for (let index = 0; index < buttons.length; index += columns) rows.push(buttons.slice(index, index + columns));
    return rows;
  }

  async sendOrEditPicker(
    identity: TelegramMessageIdentity, messageId: number | undefined, text: string, replyMarkup: InlineKeyboardMarkup,
  ): Promise<void> {
    if (messageId !== undefined) {
      try {
        await this.bot.api.editMessageText(identity.chatId, messageId, text, { reply_markup: replyMarkup });
        return;
      } catch (error) {
        if (error instanceof Error && error.message.toLowerCase().includes("message is not modified")) return;
      }
    }
    await this.bot.api.sendMessage(identity.chatId, text, {
      ...(identity.threadId === undefined ? {} : { message_thread_id: identity.threadId }),
      reply_markup: replyMarkup,
    });
  }
}
