import { createHash } from "node:crypto";

export type TelegramChatType = "private";

export interface TelegramMessageIdentity {
  chatId: number;
  chatType: TelegramChatType;
  senderId: number;
  threadId?: number;
}

export type WorkerScope = {
  kind: "user";
  id: string;
};

/** Every worker belongs to one Telegram user. */
export function workerScope(identity: TelegramMessageIdentity): WorkerScope {
  if (identity.chatType !== "private") {
    throw new Error(`Unsupported Telegram chat type: ${identity.chatType}`);
  }
  return { kind: "user", id: String(identity.senderId) };
}

export function conversationKey(identity: TelegramMessageIdentity): string {
  const scope = workerScope(identity);
  const thread = identity.threadId === undefined ? "root" : String(identity.threadId);
  return `telegram:${scope.kind}:${scope.id}:chat:${identity.chatId}:thread:${thread}`;
}

/** Filesystem-safe, non-reversible identifier for a user scope. */
export function scopeSlug(scope: WorkerScope): string {
  const digest = createHash("sha256").update(`${scope.kind}:${scope.id}`).digest("hex").slice(0, 24);
  return `${scope.kind}-${digest}`;
}
