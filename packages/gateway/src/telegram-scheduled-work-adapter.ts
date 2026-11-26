import { isAdmitted, type MessageReference } from "../../shared/src/grpc.js";
import type { TelegramMessageIdentity } from "../../shared/src/scope.js";
import type { ScheduledWorkInput, ScheduledWorkTarget } from "../../shared/src/schedule-model.js";
import { unary, collectResponse, type ConnectWorker } from "./worker-client.js";
import type { ScheduledExecution, ScheduledWorkAdapter } from "./scheduled-work-task.js";
import { telegramIdentityForTarget } from "./telegram-destination.js";

function scheduledMessageReference(input: ScheduledWorkInput, occurrenceId: string): MessageReference {
  return { conversationKey: input.target.conversationKey, requestId: `tandoor-scheduled:${occurrenceId}` };
}

export class TelegramScheduledWorkAdapter implements ScheduledWorkAdapter {
  constructor(private readonly options: {
    connectWorker: ConnectWorker;
    isAllowed(identity: TelegramMessageIdentity): boolean;
    ensurePrivateChat(actorId: string): Promise<void>;
  }) {}

  isAllowed(input: ScheduledWorkInput): boolean {
    try { return this.options.isAllowed(telegramIdentityForTarget(input.target)); }
    catch { return false; }
  }

  async prepare(target: ScheduledWorkTarget): Promise<void> {
    if (!this.options.isAllowed(telegramIdentityForTarget(target))) throw new Error("This schedule owner is not allowed.");
    await this.options.ensurePrivateChat(target.actorId);
  }

  async execute(
    input: ScheduledWorkInput, occurrenceId: string, scheduledAt: number, canStart: () => Promise<boolean>, signal: AbortSignal,
  ): Promise<ScheduledExecution> {
    const identity = telegramIdentityForTarget(input.target);
    const worker = await this.options.connectWorker(input.target.scope);
    const reference = scheduledMessageReference(input, occurrenceId);
    let receipt = await unary(worker, "inspectMessage", reference, { signal });
    if (!await canStart()) {
      if (receipt.status === "queued") await unary(worker, "cancelMessage", { ...reference, queuedOnly: true }, { signal });
      // Stop observing; an already-started worker run can finish on its own.
      return { status: "cancelled" };
    }
    if (receipt.status === "missing") {
      receipt = await unary(worker, "admitMessage", {
        // Keep due work durable in the scheduler while busy, not in a second remote queue.
        onlyIfIdle: true,
        message: {
          ...reference, channel: input.target.channel,
          text: `Scheduled work: ${input.name}\n\n${input.prompt}\n\nThis is an automated scheduled run. Do the requested work now and report the result. Do not change schedules unless explicitly requested.`,
          attachments: [], senderId: input.target.actorId, senderName: input.target.senderName,
          chatId: String(identity.chatId), threadId: identity.threadId === undefined ? "" : String(identity.threadId),
          timestampMs: scheduledAt,
        },
      }, { signal });
    }
    if (receipt.status === "busy") return { status: "busy" };
    if (!isAdmitted(receipt)) throw new Error(`The worker did not admit the scheduled occurrence (${receipt.status}).`);
    return { status: "completed", response: await collectResponse(worker, reference, signal) };
  }

  async cancel(input: ScheduledWorkInput, occurrenceId: string): Promise<void> {
    const worker = await this.options.connectWorker(input.target.scope);
    const reference = scheduledMessageReference(input, occurrenceId);
    await unary(worker, "cancelMessage", { ...reference, queuedOnly: true }, { timeoutMs: 10_000 });
  }
}
