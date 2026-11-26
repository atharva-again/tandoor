import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TaskId, Tx } from "@earendil-works/pi-durable";
import {
  createScheduledWorkInput, isScheduleArgs, isScheduledWorkTarget, scheduledTaskState, scheduledWorkOwnerKey, validateTimeZone,
  type Schedule, type ScheduleArgs, type ScheduledWorkInput, type ScheduledWorkOwner, type ScheduledWorkTarget,
} from "../../shared/src/schedule-model.js";
import type { GatewayWorkStore } from "./gateway-work-store.js";
import type { ScheduledWorkAdapter, ScheduledWorkTask } from "./scheduled-work-task.js";
import { migrateSchedules } from "./schedule-migration.js";
import {
  FinishedSchedule, ScheduleBook, ScheduleCatalog, ScheduleRequest, ScheduleTimeZone,
  finishedScheduleKey, rememberFinished, revokeSchedules, scheduleBookKey, scheduleCreation,
  type ScheduleBookData, type ScheduleCreation, type ScheduleEntry,
} from "./schedule-state.js";

const MAX_ACTIVE_SCHEDULES = 50;
export type ScheduleActionResult =
  | { action: "cancel"; status: "cancelled" | "finished"; name: string }
  | { action: "pause"; status: "paused" | "already_paused"; name: string }
  | { action: "resume"; status: "resumed"; name: string; scheduleId: string };

export type ScheduleSummary = {
  id: string;
  name: string;
  schedule: Schedule;
  status: string;
  nextAt?: number;
  retryAt?: number;
};

function ownedEntries(book: ScheduleBookData, owner: ScheduledWorkOwner): Array<[string, ScheduleEntry]> {
  return Object.entries(book.entries).filter(([, { input }]) => input.target.conversationKey === owner.conversationKey);
}

function findSchedule(entries: Array<[string, ScheduleEntry]>, query: string): [string, ScheduleEntry] | undefined {
  const exact = entries.find(([id, entry]) => id === query || (entry.status === "active" && String(entry.taskId) === query));
  if (exact) return exact;
  const named = entries.filter(([, entry]) => entry.input.name.toLowerCase() === query.toLowerCase());
  return named.length === 1 ? named[0] : undefined;
}

function enforceCapacity(entries: Array<[string, ScheduleEntry]>): void {
  if (entries.filter(([, entry]) => entry.status === "active").length >= MAX_ACTIVE_SCHEDULES) {
    throw new Error(`This chat already has ${MAX_ACTIVE_SCHEDULES} active schedules.`);
  }
}

export class ScheduleService {
  constructor(
    private readonly store: GatewayWorkStore,
    private readonly task: ScheduledWorkTask,
    private readonly adapter: ScheduledWorkAdapter,
  ) {}

  async initialize(): Promise<void> {
    const tasks = await this.store.harness.commit(async (tx) => {
      const tasks = await migrateSchedules(tx, this.store.rootId);
      const catalog = await tx.doc(ScheduleCatalog);
      for (const key of catalog.books) {
        const revoked = await revokeSchedules(tx, key, (input) => !this.adapter.isAllowed(input));
        tasks.push(...revoked);
      }
      return tasks;
    }, BACKGROUND_CONTEXT);
    this.abortTasks(tasks);
  }

  async createSchedule(target: ScheduledWorkTarget, args: ScheduleArgs, callId: string): Promise<ScheduleCreation> {
    if (!isScheduledWorkTarget(target) || !isScheduleArgs(args)) throw new Error("The schedule details are invalid.");
    if (!callId.trim() || callId.length > 200) throw new Error("The schedule request ID is invalid.");
    return this.store.harness.commit(async (tx) => {
      const ownerKey = scheduledWorkOwnerKey(target);
      const requestId = `${ownerKey}:${callId}`;
      const receipt = await tx.doc(ScheduleRequest, requestId, null);
      if (receipt.created) return { ...receipt.created, schedule: { ...receipt.created.schedule } };
      const key = scheduleBookKey(target);
      const book = await tx.doc(ScheduleBook, key, null);
      const entries = await this.removeDeadTasks(tx, book, target);
      enforceCapacity(entries);
      const { timeZone } = await tx.doc(ScheduleTimeZone, ownerKey, null);
      const input = createScheduledWorkInput(args, Date.now(), timeZone ?? undefined, requestId, target);
      if (entries.some(([, entry]) => entry.input.name.toLowerCase() === input.name.toLowerCase())) {
        throw new Error(`A schedule named "${input.name}" already exists. Choose a different name.`);
      }
      book.entries[input.scheduleId] = await this.startTask(tx, input);
      const catalog = await tx.doc(ScheduleCatalog);
      if (!catalog.books.includes(key)) catalog.books.push(key);
      const created = scheduleCreation(input.scheduleId, input);
      receipt.created = created;
      return created;
    }, BACKGROUND_CONTEXT);
  }

  async listSchedules(owner: ScheduledWorkOwner): Promise<ScheduleSummary[]> {
    return this.store.harness.commit(async (tx) => {
      const book = await tx.doc(ScheduleBook, scheduleBookKey(owner), null);
      const summaries = await Promise.all(ownedEntries(book, owner).map(async ([id, entry]): Promise<ScheduleSummary | undefined> => {
        const { name, schedule } = entry.input;
        if (entry.status === "paused") return { id, name, schedule: { ...schedule }, status: "paused", nextAt: entry.nextRunAt };
        const task = await tx.task(entry.taskId as TaskId);
        if (!task || task.state.status === "terminal") return undefined;
        const state = scheduledTaskState(task.state);
        const checkpoint = state?.checkpoint;
        const summary: ScheduleSummary = { id, name, schedule: { ...schedule }, status: task.state.status };
        if (checkpoint?.phase === "wait") summary.nextAt = state?.until ?? checkpoint.nextAt;
        if (checkpoint?.phase === "settle") {
          const delivery = await tx.task(checkpoint.deliveryTaskId as TaskId);
          if (delivery?.state.status === "sleeping") summary.retryAt = delivery.state.until;
        }
        return summary;
      }));
      return summaries.filter((summary) => summary !== undefined);
    }, BACKGROUND_CONTEXT);
  }

  async manageSchedule(operation: "cancel" | "pause" | "resume", owner: ScheduledWorkOwner, query: string): Promise<ScheduleActionResult> {
    const change = await this.store.harness.commit(async (tx): Promise<{ result: ScheduleActionResult; stop?: TaskId }> => {
      const book = await tx.doc(ScheduleBook, scheduleBookKey(owner), null);
      const entries = await this.removeDeadTasks(tx, book, owner);
      const match = findSchedule(entries, query);
      if (!match) {
        if (operation === "cancel") {
          const exact = await tx.doc(FinishedSchedule, finishedScheduleKey(owner, "id", query), null);
          const finished = exact.id !== null ? exact
            : await tx.doc(FinishedSchedule, finishedScheduleKey(owner, "name", query.toLowerCase()), null);
          if (finished.id !== null && !finished.ambiguous) {
            return { result: { action: "cancel", status: "finished", name: finished.name } };
          }
        }
        throw new Error(`No unique ${operation === "resume" ? "paused" : "active"} schedule matched "${query}".`);
      }
      const [id, entry] = match;
      const { input } = entry;
      const { name } = input;
      switch (operation) {
        case "cancel":
          await rememberFinished(tx, input.target, id, name, entry.status === "active" ? entry.taskId : undefined);
          delete book.entries[id];
          return {
            result: { action: "cancel", status: "cancelled", name },
            ...(entry.status === "active" ? { stop: entry.taskId as TaskId } : {}),
          };
        case "pause": {
          if (entry.status === "paused") return { result: { action: "pause", status: "already_paused", name } };
          const task = await tx.task(entry.taskId as TaskId);
          const state = task && scheduledTaskState(task.state);
          if (state?.status !== "sleeping" || state.checkpoint?.phase !== "wait") {
            throw new Error("This schedule is currently running or delivering a result. Try again after it settles.");
          }
          book.entries[id] = { status: "paused", input: { ...input, scheduleId: id }, nextRunAt: state.until ?? state.checkpoint.nextAt };
          return { result: { action: "pause", status: "paused", name }, stop: entry.taskId as TaskId };
        }
        case "resume":
          if (entry.status !== "paused") throw new Error(`No unique paused schedule matched "${query}".`);
          enforceCapacity(entries);
          book.entries[id] = await this.startTask(tx, { ...input, scheduleId: id, firstRunAt: entry.nextRunAt });
          return { result: { action: "resume", status: "resumed", name, scheduleId: id } };
      }
    }, BACKGROUND_CONTEXT);
    if (change.stop !== undefined) this.abortTasks([change.stop]);
    return change.result;
  }

  async setTimeZone(owner: ScheduledWorkOwner, timeZone: string, label: string): Promise<{ timeZone: string; label: string }> {
    const normalized = timeZone.trim();
    validateTimeZone(normalized);
    const name = label.trim().slice(0, 100) || normalized;
    await this.store.harness.commit(async (tx) => {
      const zone = await tx.doc(ScheduleTimeZone, scheduledWorkOwnerKey(owner), null);
      zone.timeZone = normalized;
      zone.label = name;
    }, BACKGROUND_CONTEXT);
    return { timeZone: normalized, label: name };
  }

  private async removeDeadTasks(tx: Tx, book: ScheduleBookData, owner: ScheduledWorkOwner) {
    const live: Array<[string, ScheduleEntry]> = [];
    for (const [id, entry] of ownedEntries(book, owner)) {
      if (entry.status === "active") {
        const task = await tx.task(entry.taskId as TaskId);
        if (!task || task.state.status === "terminal") {
          await rememberFinished(tx, entry.input.target, id, entry.input.name, entry.taskId);
          delete book.entries[id];
          continue;
        }
      }
      live.push([id, entry]);
    }
    return live;
  }

  private async startTask(tx: Tx, input: ScheduledWorkInput): Promise<ScheduleEntry> {
    const taskId = await tx.createTask(this.task, input, {
      ownership: { kind: "conversation" }, conversationId: this.store.rootId, background: true,
    });
    return { status: "active", input, taskId };
  }

  private abortTasks(taskIds: TaskId[]): void {
    for (const id of taskIds) {
      void this.store.harness.abortTask(id, BACKGROUND_CONTEXT).catch((error: unknown) =>
        console.error(`Could not stop obsolete schedule task ${id}:`, error));
    }
  }
}
