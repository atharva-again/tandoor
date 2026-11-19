import type { Context } from "@earendil-works/chord/context";
import { LiveDoc, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { conversationKey } from "../../shared/src/scope.js";

export interface TelegramRunContext {
  conversationKey: string;
  actorId: string;
  senderName: string;
  chatId: string;
  threadId: string;
  channel: string;
  timestampMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function telegramRunContext(entry: unknown): TelegramRunContext | undefined {
  if (!isRecord(entry) || entry.kind !== "tandoor.telegram.input" || !isRecord(entry.data)) return undefined;
  const data = entry.data;
  if (
    typeof data.senderId !== "string" ||
    !/^\d{1,20}$/.test(data.senderId) ||
    typeof data.chatId !== "string" ||
    !/^-?\d{1,20}$/.test(data.chatId) ||
    typeof data.threadId !== "string" ||
    (data.threadId !== "" && !/^\d{1,20}$/.test(data.threadId)) ||
    typeof data.senderName !== "string" ||
    typeof data.channel !== "string" ||
    typeof data.timestampMs !== "number" ||
    !Number.isFinite(data.timestampMs)
  ) {
    return undefined;
  }
  return {
    conversationKey: conversationKey({
      chatId: Number(data.chatId),
      senderId: Number(data.senderId),
      chatType: "private",
      ...(data.threadId ? { threadId: Number(data.threadId) } : {}),
    }),
    actorId: data.senderId,
    senderName: data.senderName,
    chatId: data.chatId,
    threadId: data.threadId,
    channel: data.channel,
    timestampMs: data.timestampMs,
  };
}

/** Resolve the Telegram actor and destination from this run's placed inputs. */
export async function telegramEntriesForRun(api: ToolExecutionApi, context: Context) {
  const live = await api.snapshot(LiveDoc, api.conversationId, context);
  const inputs = live?.run?.inputs;
  if (!inputs?.length) throw new Error("No active Telegram message owns this run.");

  // Read the entries for this run's submissions, rather than scanning from run.first
  // through the transcript tail (which may include unrelated later entries).
  return api.commit(async (tx) => {
    const result = [];
    for (const submissionId of inputs) {
      const submission = await tx.submission(submissionId);
      if (
        !submission ||
        submission.type !== "input" ||
        submission.status !== "placed" ||
        submission.conversationId !== api.conversationId
      ) {
        throw new Error("This run is not tied to a Telegram sender.");
      }
      const entry = await tx.entry(submission.entry);
      if (!entry) throw new Error("This run is not tied to a Telegram sender.");
      result.push(entry);
    }
    return result;
  }, context);
}

export async function telegramContextForRun(api: ToolExecutionApi, context: Context): Promise<TelegramRunContext> {
  const entries = await telegramEntriesForRun(api, context);

  const telegramInputs: TelegramRunContext[] = [];
  for (const entry of entries) {
    const input = telegramRunContext(entry);
    if (input) telegramInputs.push(input);
  }

  if (telegramInputs.length === 0) {
    throw new Error("This run is not tied to a Telegram sender. Account-bound integrations are unavailable.");
  }
  const senders = new Set(telegramInputs.map((input) => input.actorId));
  if (senders.size > 1) {
    throw new Error("This run includes messages from multiple people. Ask again in a fresh message before using a personal account.");
  }
  const first = telegramInputs[0]!;
  if (
    telegramInputs.some(
      (input) => input.chatId !== first.chatId || input.threadId !== first.threadId || input.channel !== first.channel,
    )
  ) {
    throw new Error("This run includes messages from multiple Telegram destinations. Ask again in a fresh message.");
  }
  return first;
}

