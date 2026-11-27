import { defineTask, type TaskId } from "@earendil-works/pi-durable";
import type { AgentResponse } from "../../shared/src/agent-response.js";
import type { ScheduledWorkTarget } from "../../shared/src/schedule-model.js";
import { ScheduleBook, ownsSchedule, revokeSchedules, scheduleBookKey } from "./schedule-state.js";

export type ResponsePresentation = { statusMessageId: number; editMessageId?: number };
export type ResponseDeliveryInput = {
  target: ScheduledWorkTarget;
  response: AgentResponse;
  deliveryId: string;
  scheduleId?: string;
  scheduleTaskId?: number;
  presentation?: ResponsePresentation;
};
export type DeliveryResult = { status: "delivered" | "partial" | "skipped" | "unreachable" };
export type DeliveryFailure =
  | { kind: "retry"; minimumDelayMs?: number }
  | { kind: "unreachable" }
  | { kind: "rejected" };

const incompleteNotice = "One or more parts of this response could not be delivered.";
type DeliveryCheckpoint = {
  phase: "send";
  nextPart: number;
  attempt: number;
  rejected?: boolean;
  firstPartRejected?: boolean;
};

export interface ResponseDeliveryAdapter {
  isAllowed(target: ScheduledWorkTarget): boolean;
  partCount(response: AgentResponse): number;
  sendPart(input: ResponseDeliveryInput, index: number, signal: AbortSignal): Promise<void>;
  classifyFailure(error: unknown): DeliveryFailure;
  cleanup(input: ResponseDeliveryInput, disposition: "delivered" | "skipped" | "aborted"): Promise<void>;
}

export function createResponseDeliveryTask(
  adapters: ReadonlyMap<string, ResponseDeliveryAdapter>,
  legacyDeliveredIds: ReadonlySet<string> = new Set(),
) {
  return defineTask<ResponseDeliveryInput, DeliveryCheckpoint, DeliveryResult>({
    name: "tandoor.response-delivery",
    version: 1,
    initial: () => ({ phase: "send", nextPart: 0, attempt: 0 }),
    phases: {
      send: async (task, runtime, context) => {
        const adapter = adapters.get(task.input.target.clientId);
        if (!adapter) throw new Error("The response delivery client is unavailable.");
        if (legacyDeliveredIds.has(task.input.deliveryId)) {
          await runtime.commit(() => ({
            status: "terminal", outcome: { status: "completed", result: { status: "delivered" } },
          }), context);
          return;
        }
        const bookKey = scheduleBookKey(task.input.target);
        const { scheduleId, scheduleTaskId } = task.input;
        const revoked = scheduleId !== undefined && !ownsSchedule(await runtime.snapshot(ScheduleBook, bookKey, context), {
          scheduleId, ...(scheduleTaskId !== undefined ? { taskId: scheduleTaskId } : {}),
        });
        if (revoked || !adapter.isAllowed(task.input.target)) {
          // Revocation is a final decision, not a failed delivery to retry.
          await adapter.cleanup(task.input, "skipped");
          await runtime.commit(() => ({
            status: "terminal", outcome: { status: "completed", result: { status: "skipped" } },
          }), context);
          return;
        }
        const checkpoint = task.state.checkpoint;
        const partCount = adapter.partCount(task.input.response);
        const notice = checkpoint.rejected && checkpoint.nextPart === partCount;
        if (checkpoint.nextPart >= partCount && !notice) {
          await adapter.cleanup(task.input, checkpoint.firstPartRejected ? "skipped" : "delivered");
          await runtime.commit(() => ({
            status: "terminal", outcome: { status: "completed", result: { status: checkpoint.rejected ? "partial" : "delivered" } },
          }), context);
          return;
        }
        try {
          if (notice) {
            const { target, deliveryId } = task.input;
            await adapter.sendPart({ target, deliveryId, response: { text: incompleteNotice, attachments: [] } }, 0, runtime.signal);
          } else {
            await adapter.sendPart(task.input, checkpoint.nextPart, runtime.signal);
          }
        } catch (error) {
          runtime.signal.throwIfAborted();
          runtime.report(error);
          const failure = adapter.classifyFailure(error);
          switch (failure.kind) {
            case "unreachable":
              await adapter.cleanup(task.input, "skipped");
              await runtime.commit(async (tx) => {
                await revokeSchedules(tx, bookKey, ({ target }) =>
                  target.clientId === task.input.target.clientId &&
                  target.scope.id === task.input.target.scope.id,
                );
                return { status: "terminal", outcome: { status: "completed", result: { status: "unreachable" } } };
              }, context);
              return;
            case "retry": {
              const backoff = Math.min(60 * 60_000, 1_000 * 2 ** Math.min(checkpoint.attempt, 12));
              await runtime.sleepUntil(
                runtime.now() + Math.max(backoff, failure.minimumDelayMs ?? 0),
                { ...checkpoint, attempt: Math.min(checkpoint.attempt + 1, 12) }, context,
              );
              return;
            }
            case "rejected":
              await runtime.commit(() => ({
                status: "running",
                checkpoint: {
                  ...checkpoint, nextPart: checkpoint.nextPart + 1, attempt: 0, rejected: true,
                  ...(checkpoint.nextPart === 0 ? { firstPartRejected: true } : {}),
                },
              }), context);
              return;
          }
        }
        // Each text chunk/file has its own receipt. A later failure does not replay earlier parts.
        await runtime.commit(() => ({
          status: "running",
          checkpoint: { ...checkpoint, nextPart: checkpoint.nextPart + 1, attempt: 0 },
        }), context);
      },
    },
    abort: async (task, runtime, context) => {
      await adapters.get(task.input.target.clientId)?.cleanup(task.input, "aborted");
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
}

export type ResponseDeliveryTask = ReturnType<typeof createResponseDeliveryTask>;
export type DeliveryTaskId = TaskId<DeliveryResult>;
