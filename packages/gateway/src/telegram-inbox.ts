import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDocFamily, defineTask, type TaskId } from "@earendil-works/pi-durable";
import { status as grpcStatus } from "@grpc/grpc-js";
import { isAdmitted, type AgentMessage } from "../../shared/src/grpc.js";
import { restoreAttachment, storeAttachment, type ResponseAttachment } from "../../shared/src/agent-response.js";
import type { TelegramMessageIdentity } from "../../shared/src/scope.js";
import type { GatewayWorkStore } from "./gateway-work-store.js";
import type { ResponseDeliveryTask } from "./response-delivery.js";
import type { ReplyInput, TelegramReplyTask } from "./telegram-replies.js";
import { telegramIdentityForTarget, telegramTarget } from "./telegram-destination.js";
import type { TelegramUI } from "./telegram-ui.js";
import { unary, type ConnectWorker } from "./worker-client.js";

type StoredMessage = Omit<AgentMessage, "attachments"> & { attachments: ResponseAttachment[] };

const InputReceipt = defineDocFamily<{ taskId: number | null; pending: StoredMessage | null }, null>({
  // Existing receipts already have a delivery owner and must not admit again.
  kind: "tandoor.telegram-reply", version: 2, family: true, scope: "session",
  initial: () => ({ taskId: null, pending: null }),
  migrate(value) {
    const { taskId } = value;
    if (taskId !== null && typeof taskId !== "number") throw new Error("The legacy Telegram receipt is invalid.");
    return { taskId, pending: null };
  },
  checkpointWhen: () => false,
});
const AdmissionLane = defineDocFamily<{ tail: number | null }, null>({
  kind: "tandoor.telegram-admission-lane", version: 1, family: true, scope: "session",
  initial: () => ({ tail: null }), checkpointWhen: () => false,
});

export function createTelegramAdmissionTask(
  ui: TelegramUI, connectWorker: ConnectWorker, replyTask: TelegramReplyTask, deliveryTask: ResponseDeliveryTask,
) {
  return defineTask<ReplyInput & { previous: number | null },
    { phase: "order" } | { phase: "admit"; attempt: number }, null>({
    name: "tandoor.telegram-admission", version: 1,
    initial: () => ({ phase: "order" }),
    phases: {
      order: async ({ input }, runtime, context) => {
        await runtime.commit(async (tx) => {
          const prior = input.previous === null ? undefined : await tx.task(input.previous as TaskId);
          const checkpoint = { phase: "admit", attempt: 0 } as const;
          return prior && prior.state.status !== "terminal"
            ? { status: "waiting", on: [prior.id], policy: "allSettled", checkpoint }
            : { status: "running", checkpoint };
        }, context);
      },
      admit: async ({ input, state }, runtime, context) => {
        const { reference, target } = input;
        const key = reference.requestId;
        const allowed = ui.isAllowed(telegramIdentityForTarget(target));
        let rejected = false;
        if (allowed) {
          const pending = (await runtime.snapshot(InputReceipt, key, context))?.pending;
          if (!pending) throw new Error("The durable Telegram input is missing.");
          try {
            const worker = await connectWorker(target.scope);
            const message = { ...pending, attachments: pending.attachments.map(restoreAttachment) };
            const receipt = await unary(worker, "admitMessage", { message, onlyIfIdle: false }, { signal: runtime.signal });
            if (!isAdmitted(receipt)) throw new Error(`The worker did not admit the Telegram input (${receipt.status}).`);
          } catch (error) {
            runtime.signal.throwIfAborted();
            runtime.report(error);
            rejected = error instanceof Error && "code" in error && error.code === grpcStatus.INVALID_ARGUMENT;
            if (!rejected) {
              const { attempt } = state.checkpoint;
              await runtime.sleepUntil(runtime.now() + Math.min(60_000, 2_000 * 2 ** attempt), {
                phase: "admit", attempt: Math.min(attempt + 1, 5),
              }, context);
              return;
            }
          }
        }
        await runtime.commit(async (tx) => {
          (await tx.doc(InputReceipt, key, null)).pending = null;
          const options = { conversationId: runtime.conversationId, ownership: { kind: "conversation" }, background: true } as const;
          if (!allowed) return { status: "terminal", outcome: { status: "aborted" } };
          if (rejected) {
            await tx.createTask(deliveryTask, {
              target, deliveryId: key,
              response: { text: "Tandoor could not accept this message. Try sending it again without the attachment.", attachments: [] },
            }, options);
          } else {
            await tx.createTask(replyTask, { target, reference }, options);
          }
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: async ({ input }, runtime, context) => {
      await runtime.commit(async (tx) => {
        (await tx.doc(InputReceipt, input.reference.requestId, null)).pending = null;
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });
}

export class TelegramInbox {
  constructor(
    private readonly store: GatewayWorkStore,
    private readonly task: ReturnType<typeof createTelegramAdmissionTask>,
  ) {}

  /** Accept locally before Telegram acknowledgement. Only admission, not runs, is ordered here. */
  async accept(message: AgentMessage, identity: TelegramMessageIdentity): Promise<void> {
    const store = this.store;
    const { conversationKey, requestId } = message;
    await store.harness.commit(async (tx) => {
      const receipt = await tx.doc(InputReceipt, requestId, null);
      if (receipt.taskId !== null) return;
      const lane = await tx.doc(AdmissionLane, conversationKey, null);
      receipt.pending = { ...message, attachments: message.attachments.map(storeAttachment) };
      receipt.taskId = await tx.createTask(this.task, {
        reference: { conversationKey, requestId },
        target: telegramTarget(identity, message.senderName),
        previous: lane.tail,
      }, { conversationId: store.rootId, ownership: { kind: "conversation" }, background: true });
      lane.tail = receipt.taskId;
    }, BACKGROUND_CONTEXT);
  }
}
