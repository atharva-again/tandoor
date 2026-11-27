import type { TelegramMessageIdentity } from "../../shared/src/scope.js";
import type { ResponsePresentation } from "./response-delivery.js";
import { previewText, splitTelegramText } from "./telegram-message-formatting.js";
import type { InlineKeyboardMarkup } from "./telegram-base.js";
import type { TelegramUI } from "./telegram-ui.js";
import { formatRejected, telegramBadRequest, withTelegramDeadline } from "./telegram-send-policy.js";

/** Ephemeral progress only. Final output and cleanup belong to the durable delivery task. */
export class TelegramResponsePresenter {
  private latest = "";
  private timer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private pending = Promise.resolve();
  private mode: "unstarted" | "draft" | "preview" = "unstarted";
  private stopped = false;
  private readonly draftId = Math.floor(Math.random() * 2_000_000_000) + 1;

  constructor(
    private readonly ui: TelegramUI,
    private readonly identity: TelegramMessageIdentity,
    private readonly statusMessageId: number,
    private readonly markup: InlineKeyboardMarkup,
    private readonly signal: AbortSignal,
  ) {}

  restoreButtons(): void {
    this.pending = withTelegramDeadline((signal) => this.ui.bot.api.editMessageReplyMarkup(
      this.identity.chatId, this.statusMessageId, { reply_markup: this.markup }, signal,
    ), this.signal).then(() => undefined, () => undefined);
  }

  update(text: string): void {
    this.latest = splitTelegramText(previewText(text))[0] ?? "";
    if (this.timer || this.stopped || !this.latest) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pending = this.pending.then(() => this.flush()).catch((error: unknown) => {
        console.warn("Telegram progress update failed:", error instanceof Error ? error.message : error);
      });
    }, 800);
  }

  private async flush(): Promise<void> {
    if (this.stopped || !this.latest) return;
    const { chatId } = this.identity;
    if (this.mode !== "preview") {
      try {
        await withTelegramDeadline((signal) => this.ui.bot.api.sendRichMessageDraft(chatId, this.draftId, {
          markdown: this.latest,
        }, {}, signal), this.signal);
        this.startDraftHeartbeat();
        return;
      } catch (error) {
        if (telegramBadRequest(error, formatRejected)) {
          try {
            await withTelegramDeadline((signal) => this.ui.bot.api.sendRichMessageDraft(chatId, this.draftId, {
              blocks: [{ type: "paragraph", text: this.latest }],
            }, {}, signal), this.signal);
            this.startDraftHeartbeat();
            return;
          } catch {
            // A Markdown prefix may be temporarily incomplete while it streams.
          }
        }
        // Switch presenter ownership once; no job-wide flags or cleanup assumptions.
        this.mode = "preview";
        if (this.heartbeat) clearInterval(this.heartbeat);
      }
    }
    await withTelegramDeadline((signal) => this.ui.bot.api.editMessageText(
      chatId, this.statusMessageId, this.latest, { reply_markup: this.markup }, signal,
    ), this.signal)
      .catch(() => undefined);
  }

  private startDraftHeartbeat(): void {
    this.mode = "draft";
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.update(this.latest), 20_000);
      this.heartbeat.unref?.();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.pending;
  }

  presentation(): ResponsePresentation {
    return {
      statusMessageId: this.statusMessageId,
      ...(this.mode === "draft" ? {} : { editMessageId: this.statusMessageId }),
    };
  }
}
