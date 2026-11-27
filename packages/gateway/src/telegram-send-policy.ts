import { GrammyError } from "grammy";
import { AbortController, type AbortSignal as TelegramSignal } from "abort-controller";
import type { DeliveryFailure } from "./response-delivery.js";

export async function withTelegramDeadline<T>(
  send: (signal: TelegramSignal) => Promise<T>, signal?: AbortSignal, ms = 8_000,
): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, ms);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await send(controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export function telegramBadRequest(error: unknown, description: RegExp): boolean {
  return error instanceof GrammyError && error.error_code === 400 && description.test(error.description);
}

export const formatRejected = /(?:can't|cannot|failed to|could not) parse|unsupported (?:markup|markdown|rich (?:message|text|block))|rich (?:message|text|block) (?:is )?invalid/i;
export const mediaRejected = /invalid (?:photo|image|animation)|(?:photo|image|animation|video).*(?:invalid|unsupported|required|dimensions|format|too (?:big|small|large))|IMAGE_PROCESS_FAILED|PHOTO_INVALID_DIMENSIONS|MEDIA_EMPTY|WRONG_FILE_TYPE/i;
export const messageNotModified = /message is not modified/i;
export const messageNotEditable = /message to edit not found|message (?:can't|can not) be edited/i;

export function classifyTelegramSendFailure(error: unknown): DeliveryFailure {
  // An HTTP/network failure may have happened after Telegram accepted the send.
  if (!(error instanceof GrammyError)) return { kind: "retry" };
  const { error_code: code, description, parameters } = error;
  if (code === 429) return { kind: "retry", minimumDelayMs: (parameters.retry_after ?? 0) * 1_000 };
  if (code === 408 || code >= 500) return { kind: "retry" };
  if (code === 403 || /chat not found|bot was blocked|user is deactivated|can't initiate conversation/i.test(description)) {
    return { kind: "unreachable" };
  }
  return { kind: "rejected" };
}
