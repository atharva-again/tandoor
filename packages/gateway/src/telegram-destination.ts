import type { ScheduledWorkTarget } from "../../shared/src/schedule-model.js";
import { conversationKey, workerScope, type TelegramMessageIdentity } from "../../shared/src/scope.js";

export function telegramIdentityForTarget(target: ScheduledWorkTarget): TelegramMessageIdentity {
  const { destination } = target;
  const chatId = typeof destination.chatId === "string" ? Number(destination.chatId) : NaN;
  const senderId = Number(target.actorId);
  const thread = typeof destination.threadId === "string" ? destination.threadId : "";
  const threadId = thread ? Number(thread) : undefined;
  if (target.clientId !== "telegram" || destination.chatType !== "private" ||
    !Number.isSafeInteger(chatId) || chatId <= 0 || !Number.isSafeInteger(senderId) || senderId <= 0 ||
    (threadId !== undefined && (!Number.isSafeInteger(threadId) || threadId <= 0))) {
    throw new Error("The Telegram destination is invalid.");
  }
  const identity: TelegramMessageIdentity = {
    chatId, senderId, chatType: "private", ...(threadId === undefined ? {} : { threadId }),
  };
  const currentKey = conversationKey(identity);
  const legacyLinearKey = threadId === undefined &&
    target.conversationKey === currentKey.slice(0, -":thread:root".length);
  if (chatId !== senderId || workerScope(identity).id !== target.scope.id ||
    (target.conversationKey !== currentKey && !legacyLinearKey)) {
    throw new Error("The Telegram destination does not match its conversation.");
  }
  return identity;
}

export function telegramTarget(identity: TelegramMessageIdentity, senderName: string): ScheduledWorkTarget {
  return {
    clientId: "telegram", scope: workerScope(identity), conversationKey: conversationKey(identity),
    actorId: String(identity.senderId), senderName, channel: "telegram",
    destination: {
      chatId: String(identity.chatId),
      threadId: identity.threadId === undefined ? "" : String(identity.threadId),
      chatType: "private",
    },
  };
}
