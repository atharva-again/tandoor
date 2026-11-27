import { InputFile } from "grammy";
import type { AbortSignal as TelegramSignal } from "abort-controller";
import type { AgentResponse } from "../../shared/src/agent-response.js";
import { splitTelegramText } from "./telegram-message-formatting.js";
import { safeTelegramFilename } from "./telegram-base.js";
import type { ResponseDeliveryAdapter, ResponseDeliveryInput } from "./response-delivery.js";
import { telegramIdentityForTarget } from "./telegram-destination.js";
import type { ScheduledWorkTarget } from "../../shared/src/schedule-model.js";
import type { TelegramUI } from "./telegram-ui.js";
import {
  classifyTelegramSendFailure, formatRejected, mediaRejected, messageNotEditable, messageNotModified,
  telegramBadRequest, withTelegramDeadline,
} from "./telegram-send-policy.js";

/** All final replies use the same text/file transport, regardless of how the work started. */
export class TelegramDelivery implements ResponseDeliveryAdapter {
  constructor(private readonly ui: TelegramUI) {}

  isAllowed(target: ScheduledWorkTarget): boolean {
    return this.ui.isAllowed(telegramIdentityForTarget(target));
  }

  private chunks(response: AgentResponse): string[] {
    return response.text.trim() ? splitTelegramText(response.text)
      : response.attachments.length ? [] : ["(No text response.)"];
  }

  partCount(response: AgentResponse): number {
    return this.chunks(response).length + response.attachments.length;
  }

  sendPart(input: ResponseDeliveryInput, index: number, signal: AbortSignal): Promise<void> {
    return withTelegramDeadline((deadline) => this.send(input, index, deadline), signal, 90_000);
  }

  private async send(input: ResponseDeliveryInput, index: number, sendSignal: TelegramSignal): Promise<void> {
    const identity = telegramIdentityForTarget(input.target);
    const options = {};
    const { api } = this.ui.bot;
    const chunks = this.chunks(input.response);
    if (index < chunks.length) {
      const text = chunks[index]!;
      if (index === 0 && input.presentation?.editMessageId !== undefined) {
        const messageId = input.presentation.editMessageId;
        try {
          await api.editMessageText(identity.chatId, messageId, { markdown: text }, { reply_markup: { inline_keyboard: [] } }, sendSignal);
        } catch (error) {
          if (telegramBadRequest(error, messageNotModified)) return;
          if (telegramBadRequest(error, messageNotEditable)) {
            await this.sendText(identity.chatId, text, options, sendSignal);
            return;
          }
          if (!telegramBadRequest(error, formatRejected)) throw error;
          try {
            await api.editMessageText(identity.chatId, messageId, text, { reply_markup: { inline_keyboard: [] } }, sendSignal);
          } catch (plainError) {
            if (telegramBadRequest(plainError, messageNotModified)) return;
            if (!telegramBadRequest(plainError, messageNotEditable)) throw plainError;
            await api.sendMessage(identity.chatId, text, options, sendSignal);
          }
        }
      } else {
        await this.sendText(identity.chatId, text, options, sendSignal);
      }
      return;
    }
    const attachment = input.response.attachments[index - chunks.length];
    if (!attachment) throw new Error("The response part does not exist.");
    const file = new InputFile(Buffer.from(attachment.data, "base64"), safeTelegramFilename(attachment.filename));
    const mime = attachment.mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
    if (mime.startsWith("image/")) {
      try {
        if (mime === "image/gif") await api.sendAnimation(identity.chatId, file, options, sendSignal);
        else await api.sendPhoto(identity.chatId, file, options, sendSignal);
        return;
      } catch (error) {
        if (!telegramBadRequest(error, mediaRejected)) throw error;
      }
    }
    await api.sendDocument(identity.chatId, file, options, sendSignal);
  }

  classifyFailure(error: unknown) {
    return classifyTelegramSendFailure(error);
  }

  private async sendText(chatId: number, text: string, options: {}, signal: TelegramSignal): Promise<void> {
    const { api } = this.ui.bot;
    try { await api.sendRichMessage(chatId, { markdown: text }, options, signal); }
    catch (error) {
      if (!telegramBadRequest(error, formatRejected)) throw error;
      await api.sendMessage(chatId, text, options, signal);
    }
  }

  async cleanup(input: ResponseDeliveryInput, disposition: "delivered" | "skipped" | "aborted"): Promise<void> {
    const presentation = input.presentation;
    if (!presentation) return;
    // An editable preview becomes the answer. Only a separate Stop/status message is disposable.
    if (disposition === "delivered" && presentation.editMessageId === presentation.statusMessageId && this.chunks(input.response).length) return;
    const identity = telegramIdentityForTarget(input.target);
    await withTelegramDeadline((signal) =>
      this.ui.bot.api.deleteMessage(identity.chatId, presentation.statusMessageId, signal)).catch(() => false);
  }
}
