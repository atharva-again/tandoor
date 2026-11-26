import { defineDoc, defineDocFamily, type TaskId, type Tx } from "@earendil-works/pi-durable";
import {
  scheduledWorkOwnerKey,
  type ScheduledWorkInput, type ScheduledWorkOwner, type ScheduledWorkTarget,
} from "../../shared/src/schedule-model.js";

export const TASK_NAME = "tandoor.scheduled-work";

type ActiveSchedule = { status: "active"; input: ScheduledWorkInput; taskId: number };
type PausedSchedule = { status: "paused"; input: ScheduledWorkInput; nextRunAt: number };
export type ScheduleEntry = ActiveSchedule | PausedSchedule;
export type ScheduleBookData = { entries: Record<string, ScheduleEntry> };
export type ScheduleLink = { scheduleId: string; taskId?: number };
export type ScheduleCreation = Pick<ScheduledWorkInput, "name" | "firstRunAt" | "schedule"> & { scheduleId: string };

// A book contains only live schedules for one client/user, including their topics.
// A task may start an occurrence or send its result only while it owns this record.
export const ScheduleBook = defineDocFamily<ScheduleBookData, null>({
  kind: "tandoor.schedule-book", version: 1, family: true, scope: "session",
  initial: () => ({ entries: {} }), checkpointWhen: () => false,
});
export const ScheduleCatalog = defineDoc<{ migrated: boolean; books: string[] }>({
  kind: "tandoor.schedule-catalog", version: 1, scope: "session",
  initial: () => ({ migrated: false, books: [] }), checkpointWhen: () => false,
});
export const ScheduleTimeZone = defineDocFamily<{ timeZone: string | null; label: string }, null>({
  kind: "tandoor.schedule-time-zone", version: 1, family: true, scope: "session",
  initial: () => ({ timeZone: null, label: "" }), checkpointWhen: () => false,
});
export const ScheduleRequest = defineDocFamily<{ created: ScheduleCreation | null }, null>({
  kind: "tandoor.schedule-request", version: 1, family: true, scope: "session",
  initial: () => ({ created: null }), checkpointWhen: () => false,
});
export const FinishedSchedule = defineDocFamily<{ id: string | null; name: string; ambiguous: boolean }, null>({
  kind: "tandoor.finished-schedule", version: 1, family: true, scope: "session",
  initial: () => ({ id: null, name: "", ambiguous: false }), checkpointWhen: () => false,
});

export function scheduleBookKey(owner: ScheduledWorkOwner): string {
  return JSON.stringify([owner.clientId, owner.scope.kind, owner.scope.id]);
}

export function scheduleCreation(scheduleId: string, { name, firstRunAt, schedule }: ScheduledWorkInput): ScheduleCreation {
  return { scheduleId, name, firstRunAt, schedule: { ...schedule } };
}

export function finishedScheduleKey(owner: ScheduledWorkOwner, by: "id" | "name", query: string): string {
  return JSON.stringify([scheduleBookKey(owner), scheduledWorkOwnerKey(owner), by, query]);
}

export function ownsSchedule(book: Readonly<ScheduleBookData> | undefined, link: ScheduleLink): boolean {
  const entry = book?.entries[link.scheduleId];
  return entry?.status === "active" && (link.taskId === undefined || entry.taskId === link.taskId);
}

export async function rememberFinished(
  tx: Tx, target: ScheduledWorkTarget, id: string, name: string, taskId?: number,
): Promise<void> {
  for (const key of new Set([id, ...(taskId === undefined ? [] : [String(taskId)])])) {
    const exact = await tx.doc(FinishedSchedule, finishedScheduleKey(target, "id", key), null);
    exact.id = id;
    exact.name = name;
  }
  const named = await tx.doc(FinishedSchedule, finishedScheduleKey(target, "name", name.toLowerCase()), null);
  if (named.id !== null && named.id !== id) named.ambiguous = true;
  named.id = id;
  named.name = name;
}

export async function finishSchedule(tx: Tx, target: ScheduledWorkTarget, link: ScheduleLink): Promise<void> {
  const book = await tx.doc(ScheduleBook, scheduleBookKey(target), null);
  const entry = book.entries[link.scheduleId];
  if (entry?.status !== "active" || !ownsSchedule(book, link)) return;
  await rememberFinished(tx, target, link.scheduleId, entry.input.name, entry.taskId);
  delete book.entries[link.scheduleId];
}

/** Removing ownership also prevents in-flight workers' results from being delivered on restart. */
export async function revokeSchedules(tx: Tx, bookKey: string, matches: (input: ScheduledWorkInput) => boolean): Promise<TaskId[]> {
  const book = await tx.doc(ScheduleBook, bookKey, null);
  const tasks: TaskId[] = [];
  for (const [id, entry] of Object.entries(book.entries)) {
    if (!matches(entry.input)) continue;
    await rememberFinished(tx, entry.input.target, id, entry.input.name, entry.status === "active" ? entry.taskId : undefined);
    if (entry.status === "active") tasks.push(entry.taskId as TaskId);
    delete book.entries[id];
  }
  return tasks;
}
