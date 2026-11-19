import { defineTask, type TaskId } from "@earendil-works/pi-durable";
import {
  nextRunAt, publicScheduleId, scheduleInput, scheduledTaskState,
  type ScheduledWorkCheckpoint, type ScheduledWorkInput, type ScheduledWorkResult,
} from "../../shared/src/schedule-model.js";
import type { AgentResponse } from "../../shared/src/agent-response.js";
import { ScheduleBook, TASK_NAME, finishSchedule, ownsSchedule, scheduleBookKey } from "./schedule-state.js";
import type { ResponseDeliveryTask } from "./response-delivery.js";

export type ScheduledExecution =
  | { status: "busy" }
  | { status: "cancelled" }
  | { status: "completed"; response: AgentResponse };

export interface ScheduledWorkAdapter {
  isAllowed(input: ScheduledWorkInput): boolean;
  execute(input: ScheduledWorkInput, occurrenceId: string, scheduledAt: number, canStart: () => Promise<boolean>, signal: AbortSignal): Promise<ScheduledExecution>;
  cancel(input: ScheduledWorkInput, occurrenceId: string): Promise<void>;
}

function occurrenceId(input: ScheduledWorkInput, taskId: TaskId, scheduledAt: number): string {
  // Legacy schedules use an empty ID segment in their persisted worker and delivery receipts.
  return `${input.scheduleId ?? ""}:${taskId}:${scheduledAt}`;
}

export function createScheduledWorkTask(adapter: ScheduledWorkAdapter, deliveryTask: ResponseDeliveryTask) {
  type TaskIdentity = { id: TaskId; input: ScheduledWorkInput };
  const link = (task: TaskIdentity) => ({ scheduleId: publicScheduleId(task.input, task.id), taskId: task.id });
  const targetKey = (task: TaskIdentity) => scheduleBookKey(task.input.target);
  const aborted = { status: "terminal", outcome: { status: "aborted" } } as const;
  return defineTask<ScheduledWorkInput, ScheduledWorkCheckpoint, ScheduledWorkResult>({
    name: TASK_NAME,
    version: 2,
    initial: (input) => ({ phase: "wait", nextAt: input.firstRunAt, runCount: 0 }),
    migrate: (input, checkpoint) => {
      const parsedInput = scheduleInput(input);
      const parsedCheckpoint = scheduledTaskState({ status: "running", checkpoint })?.checkpoint;
      if (!parsedInput || !parsedCheckpoint) throw new Error("Invalid saved scheduled work.");
      return { input: parsedInput, checkpoint: parsedCheckpoint };
    },
    phases: {
      wait: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        await runtime.commit(async (tx) => {
          const book = await tx.doc(ScheduleBook, targetKey(task), null);
          if (!ownsSchedule(book, link(task))) return aborted;
          if (checkpoint.nextAt > runtime.now()) return { status: "sleeping", until: checkpoint.nextAt, checkpoint };
          return {
            status: "running",
            checkpoint: { phase: "run", scheduledAt: checkpoint.nextAt, runCount: checkpoint.runCount + 1 },
          };
        }, context);
      },
      run: async (task, runtime, context) => {
        const { scheduledAt, runCount } = task.state.checkpoint;
        const canStart = async () => adapter.isAllowed(task.input) &&
          ownsSchedule(await runtime.snapshot(ScheduleBook, targetKey(task), context), link(task));
        let execution: ScheduledExecution;
        try {
          execution = await canStart()
            ? await adapter.execute(task.input, occurrenceId(task.input, task.id, scheduledAt), scheduledAt, canStart, runtime.signal)
            : { status: "cancelled" };
        } catch (error) {
          runtime.signal.throwIfAborted();
          runtime.report(error);
          // Admission may have succeeded. Retry the same occurrence, not a new one.
          await runtime.sleepUntil(runtime.now() + 30_000, task.state.checkpoint, context);
          return;
        }
        switch (execution.status) {
          case "busy":
            await runtime.sleepUntil(runtime.now() + 1_000, task.state.checkpoint, context);
            break;
          case "cancelled":
            await runtime.commit(async (tx) => {
              await finishSchedule(tx, task.input.target, link(task));
              return aborted;
            }, context);
            break;
          case "completed":
            await runtime.commit(() => ({
              status: "running", checkpoint: { phase: "delivery", scheduledAt, runCount, response: execution.response },
            }), context);
            break;
        }
      },
      delivery: async (task, runtime, context) => {
        const { response, runCount, scheduledAt } = task.state.checkpoint;
        await runtime.commit(async (tx) => {
          const book = await tx.doc(ScheduleBook, targetKey(task), null);
          if (!ownsSchedule(book, link(task))) return aborted;
          const deliveryTaskId = await tx.createTask(deliveryTask, {
            target: task.input.target, response, scheduleId: link(task).scheduleId, scheduleTaskId: task.id,
            deliveryId: occurrenceId(task.input, task.id, scheduledAt),
          }, { ownership: { kind: "task", taskId: task.id }, conversationId: task.conversationId });
          return {
            status: "waiting", on: [deliveryTaskId], policy: "allSettled",
            checkpoint: { phase: "settle", scheduledAt, runCount, deliveryTaskId },
          };
        }, context);
      },
      settle: async (task, runtime, context) => {
        const { runCount, scheduledAt, deliveryTaskId } = task.state.checkpoint;
        await runtime.commit(async (tx) => {
          const book = await tx.doc(ScheduleBook, targetKey(task), null);
          const delivery = await tx.task(deliveryTaskId as TaskId);
          const nextAt = ownsSchedule(book, link(task)) && delivery?.state.outcome?.status === "completed"
            ? nextRunAt(task.input.schedule, scheduledAt, runtime.now())
            : undefined;
          if (nextAt !== undefined) {
            return { status: "sleeping", until: nextAt, checkpoint: { phase: "wait", nextAt, runCount } };
          }
          await finishSchedule(tx, task.input.target, link(task));
          return {
            status: "terminal", outcome: { status: "completed", result: { runCount, lastRunAt: scheduledAt } },
          };
        }, context);
      },
    },
    abort: async (task, runtime, context) => {
      const checkpoint = task.state.checkpoint;
      if (checkpoint.phase === "run" && adapter.isAllowed(task.input)) {
        await adapter.cancel(task.input, occurrenceId(task.input, task.id, checkpoint.scheduledAt))
          .catch((error: unknown) => runtime.report(error));
      }
      await runtime.commit(async (tx) => {
        await finishSchedule(tx, task.input.target, link(task));
        return aborted;
      }, context);
    },
  });
}

export type ScheduledWorkTask = ReturnType<typeof createScheduledWorkTask>;
