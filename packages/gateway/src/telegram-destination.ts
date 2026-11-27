import type { ScheduledWorkTarget } from "../../shared/src/schedule-model.js";
import { conversationKey, workerScope, type TelegramMessageIdentity } from "../../shared/src/scope.js";

export function telegramIdentityForTarget(target: ScheduledWorkTarget): TelegramMessageIdentity {
  const { destination } = target;
  const chatId = typeof destination.chatId === "string" ? Number(destination.chatId) : NaN;
  const senderId = Number(target.actorId);
  if (target.clientId !== "telegram" || destination.chatType !== "private" ||
    !Number.isSafeInteger(chatId) || chatId <= 0 || !Number.isSafeInteger(senderId) || senderId <= 0) {
    throw new Error("The Telegram destination is invalid.");
  }
  const identity: TelegramMessageIdentity = { chatId, senderId, chatType: "private" };
  if (
    chatId !== senderId ||
    workerScope(identity).id !== target.scope.id ||
    target.conversationKey !== conversationKey(identity)
  ) {
    throw new Error("The Telegram destination does not match its conversation.");
  }
  return identity;
}

export function telegramTarget(identity: TelegramMessageIdentity, senderName: string): ScheduledWorkTarget {
  return {
    clientId: "telegram", scope: workerScope(identity), conversationKey: conversationKey(identity),
    actorId: String(identity.senderId), senderName, channel: "telegram",
    destination: { chatId: String(identity.chatId), chatType: "private" },
  };
}
