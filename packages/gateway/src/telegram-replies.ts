import { defineTask, type TaskId } from "@earendil-works/pi-durable";
import type { MessageReference } from "../../shared/src/grpc.js";
import type { ScheduledWorkTarget } from "../../shared/src/schedule-model.js";
import { conversationKey } from "../../shared/src/scope.js";
import type { ResponseDeliveryTask } from "./response-delivery.js";
import { telegramIdentityForTarget } from "./telegram-destination.js";
import { TelegramResponsePresenter } from "./telegram-response-presenter.js";
import { withTelegramDeadline } from "./telegram-send-policy.js";
import { collectResponse, unary, type ConnectWorker } from "./worker-client.js";
import type { TelegramUI } from "./telegram-ui.js";

export type ReplyInput = { reference: MessageReference; target: ScheduledWorkTarget };
type ReplyCheckpoint =
  | { phase: "prepare" }
  | { phase: "watch"; statusMessageId?: number }
  | { phase: "done"; deliveryTaskId: number };

export function createTelegramReplyTask(ui: TelegramUI, connectWorker: ConnectWorker, deliveryTask: ResponseDeliveryTask) {
  const completed = { status: "terminal", outcome: { status: "completed", result: null } } as const;
  return defineTask<ReplyInput, ReplyCheckpoint, null>({
    name: "tandoor.telegram-reply", version: 1,
    initial: () => ({ phase: "prepare" }),
    phases: {
      prepare: async ({ input }, runtime, context) => {
        const identity = telegramIdentityForTarget(input.target);
        if (!ui.isAllowed(identity)) {
          await runtime.commit(() => completed, context);
          return;
        }
        const status = await withTelegramDeadline((signal) => ui.bot.api.sendMessage(
          identity.chatId,
          "Click the button below to stop the response",
          {
            ...(identity.threadId === undefined ? {} : { message_thread_id: identity.threadId }),
            reply_markup: stopMarkup(ui, connectWorker, input),
          },
          signal,
        ), runtime.signal).catch(() => undefined);
        await runtime.commit(() => ({
          status: "running", checkpoint: {
            phase: "watch", ...(status ? { statusMessageId: status.message_id } : {}),
          },
        }), context);
      },
      watch: async ({ input, state, id }, runtime, context) => {
        const { target, reference } = input;
        const identity = telegramIdentityForTarget(target);
        const { statusMessageId } = state.checkpoint;
        if (!ui.isAllowed(identity)) {
          if (statusMessageId !== undefined) {
            await withTelegramDeadline((signal) =>
              ui.bot.api.deleteMessage(identity.chatId, statusMessageId, signal), runtime.signal).catch(() => undefined);
          }
          await runtime.commit(() => completed, context);
          return;
        }
        const presenter = statusMessageId === undefined ? undefined : new TelegramResponsePresenter(
          ui, identity, statusMessageId, stopMarkup(ui, connectWorker, input), runtime.signal,
        );
        let response;
        try {
          const worker = await connectWorker(target.scope);
          // Rebind buttons after restart without delaying observation.
          presenter?.restoreButtons();
          presenter?.update("**Thinking…**");
          response = await collectResponse(worker, reference, runtime.signal, (text) => presenter?.update(text));
        } catch (error) {
          runtime.signal.throwIfAborted();
          runtime.report(error);
          await runtime.sleepUntil(runtime.now() + 5_000, state.checkpoint, context);
          return;
        } finally {
          await presenter?.stop();
        }
        const presentation = presenter?.presentation();
        await runtime.commit(async (tx) => {
          const deliveryTaskId = await tx.createTask(deliveryTask, {
            target, deliveryId: reference.requestId, response,
            ...(presentation ? { presentation } : {}),
          }, { ownership: { kind: "task", taskId: id }, conversationId: runtime.conversationId });
          return { status: "waiting", on: [deliveryTaskId], policy: "allSettled", checkpoint: { phase: "done", deliveryTaskId } };
        }, context);
      },
      done: async ({ state }, runtime, context) => {
        const [outcome] = await runtime.outcomes([state.checkpoint.deliveryTaskId as TaskId], context);
        if (outcome?.status !== "completed") throw new Error("Telegram response delivery did not complete.");
        await runtime.commit(() => completed, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
}

export type TelegramReplyTask = ReturnType<typeof createTelegramReplyTask>;

function stopMarkup(ui: TelegramUI, connectWorker: ConnectWorker, input: ReplyInput) {
  return { inline_keyboard: [[ui.pickerButton("Stop", async (identity) => {
    if (conversationKey(identity) !== input.reference.conversationKey) return;
    const worker = await connectWorker(input.target.scope);
    await unary(worker, "cancelMessage", input.reference);
  })]] };
}
