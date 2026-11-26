import { defineDoc, type ConversationId, type Cursor, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import {
  isPausedSchedule, isRecord, publicScheduleId, scheduleInput, scheduledTaskState,
  type ScheduledWorkInput,
} from "../../shared/src/schedule-model.js";
import {
  ScheduleBook, ScheduleCatalog, ScheduleRequest, ScheduleTimeZone, TASK_NAME,
  rememberFinished, scheduleBookKey, scheduleCreation,
} from "./schedule-state.js";

// The old root document and task history are read once, before the scheduler starts.
const LegacySchedulingState = defineDoc<Record<string, JsonValue>>({
  kind: "tandoor.scheduling", version: 2, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ paused: [], timeZones: {}, cancelled: [] }),
  migrate: (value) => ({ ...value, cancelled: [] }),
  checkpointWhen: () => false,
});

export async function migrateSchedules(tx: Tx, rootId: ConversationId): Promise<TaskId[]> {
  const catalog = await tx.doc(ScheduleCatalog);
  if (catalog.migrated) return [];
  const legacy = await tx.doc(LegacySchedulingState, rootId);
  if (!Array.isArray(legacy.paused) || !Array.isArray(legacy.cancelled) || !isRecord(legacy.timeZones)) {
    throw new Error("The legacy scheduling document is invalid.");
  }
  const books = new Set(catalog.books);
  const cancelled = new Set(legacy.cancelled);
  const obsolete: TaskId[] = [];
  const bookFor = (input: ScheduledWorkInput) => {
    const key = scheduleBookKey(input.target);
    books.add(key);
    return tx.doc(ScheduleBook, key, null);
  };
  const rememberRequest = async (id: string, input: ScheduledWorkInput) => {
    const receipt = await tx.doc(ScheduleRequest, input.createdByCallId, null);
    receipt.created ??= scheduleCreation(id, input);
  };
  const unsupported = (input: unknown) =>
    isRecord(input) && isRecord(input.target) && isRecord(input.target.scope) && input.target.scope.kind !== "user";

  for (const value of legacy.paused) {
    if (isRecord(value) && unsupported(value.input)) continue;
    if (!isPausedSchedule(value)) throw new Error("A legacy paused schedule is invalid.");
    const { input, nextRunAt } = value;
    const id = input.scheduleId;
    await rememberRequest(id, input);
    if (!cancelled.has(id)) (await bookFor(input)).entries[id] = { status: "paused", input, nextRunAt };
  }
  for (const [key, zone] of Object.entries(legacy.timeZones)) {
    if (!isRecord(zone) || typeof zone.timeZone !== "string" || typeof zone.label !== "string") {
      throw new Error("A legacy schedule time zone is invalid.");
    }
    const stored = await tx.doc(ScheduleTimeZone, key, null);
    stored.timeZone = zone.timeZone;
    stored.label = zone.label;
  }

  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ conversationId: rootId, kind: TASK_NAME, order: "descending" }, 100, cursor);
    for (const task of page.items) {
      const input = scheduleInput(task.input);
      if (!input) {
        if (task.state.status === "terminal") continue;
        if (!unsupported(task.input)) throw new Error(`Saved schedule task ${task.id} is invalid.`);
        obsolete.push(task.id);
        continue;
      }
      const id = publicScheduleId(input, task.id);
      await rememberRequest(id, input);
      if (task.state.status === "terminal" || cancelled.has(id)) {
        await rememberFinished(tx, input.target, id, input.name, task.id);
        if (task.state.status !== "terminal") obsolete.push(task.id);
        continue;
      }
      if (!scheduledTaskState(task.state)) throw new Error(`Saved schedule task ${task.id} has an invalid state.`);
      const book = await bookFor(input);
      if (book.entries[id]) obsolete.push(task.id); // A saved pause or newer task owns this ID.
      else book.entries[id] = { status: "active", input, taskId: task.id };
    }
    cursor = page.next;
  } while (cursor !== undefined);

  catalog.books = [...books];
  catalog.migrated = true;
  return obsolete;
}
