import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { JsonValue } from "@earendil-works/chord/json";
import type { WorkerScope } from "./scope.js";
import { isAgentResponse, type AgentResponse } from "./agent-response.js";

export const MAX_SCHEDULE_PROMPT_LENGTH = 8_000;

type RecurringDuration =
  | { durationMinutes?: never; endsAt?: never }
  | { durationMinutes: number; endsAt: number };

export type Schedule =
  | { type: "once"; runAt: number; timeZone?: string }
  | ({ type: "interval"; intervalMinutes: number } & RecurringDuration)
  | ({ type: "daily"; timeOfDay: string; timeZone: string } & RecurringDuration)
  | ({ type: "cron"; expression: string; timeZone: string } & RecurringDuration);

type ClockSchedule = Extract<Schedule, { type: "daily" | "cron" }>;

export type ScheduledWorkTarget = {
  clientId: string;
  scope: WorkerScope;
  conversationKey: string;
  actorId: string;
  senderName: string;
  channel: string;
  destination: Record<string, JsonValue>;
};

export type ScheduledWorkOwner = Pick<ScheduledWorkTarget, "clientId" | "conversationKey" | "scope">;

export function scheduledWorkOwnerKey(
  target: ScheduledWorkOwner,
): string {
  return `${target.clientId}:${target.conversationKey}`;
}

export function isScheduledWorkTarget(value: unknown): value is ScheduledWorkTarget {
  return (
    isRecord(value) &&
    typeof value.clientId === "string" &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(value.clientId) &&
    typeof value.conversationKey === "string" &&
    value.conversationKey.length > 0 &&
    value.conversationKey.length <= 512 &&
    isRecord(value.scope) &&
    value.scope.kind === "user" &&
    typeof value.scope.id === "string" &&
    value.scope.id.length > 0 &&
    value.scope.id.length <= 200 &&
    typeof value.actorId === "string" &&
    value.actorId.length > 0 &&
    value.actorId.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(value.actorId) &&
    typeof value.senderName === "string" &&
    value.senderName.length <= 200 &&
    typeof value.channel === "string" &&
    value.channel.length > 0 &&
    value.channel.length <= 100 &&
    isRecord(value.destination)
  );
}

export type ScheduledWorkInput = {
  /** Absent on legacy tasks; their occurrence receipts use an empty ID segment. */
  scheduleId?: string;
  name: string;
  prompt: string;
  schedule: Schedule;
  firstRunAt: number;
  createdByCallId: string;
  target: ScheduledWorkTarget;
};

export type ScheduledWorkCheckpoint =
  | { phase: "wait"; nextAt: number; runCount: number }
  | { phase: "run"; scheduledAt: number; runCount: number }
  | { phase: "delivery"; scheduledAt: number; runCount: number; response: AgentResponse }
  | { phase: "settle"; scheduledAt: number; runCount: number; deliveryTaskId: number };

export interface ScheduledWorkResult {
  runCount: number;
  lastRunAt: number;
}

export interface PausedSchedule {
  ownerKey: string;
  input: ScheduledWorkInput & { scheduleId: string };
  nextRunAt: number;
  pausedAt: number;
}

export interface ScheduledTaskStateView {
  status: string;
  until?: number;
  checkpoint?: ScheduledWorkCheckpoint;
}

export interface ScheduleArgs {
  name?: string;
  prompt: string;
  type: "once" | "interval" | "daily" | "cron";
  delayMinutes?: number;
  runAt?: string;
  intervalMinutes?: number;
  durationMinutes?: number;
  timeOfDay?: string;
  timeZone?: string;
  cron?: string;
}

export function isScheduleArgs(value: unknown): value is ScheduleArgs {
  return (
    isRecord(value) &&
    typeof value.prompt === "string" &&
    value.prompt.trim().length > 0 &&
    value.prompt.length <= MAX_SCHEDULE_PROMPT_LENGTH &&
    (value.name === undefined || (typeof value.name === "string" && value.name.length <= 80)) &&
    (value.type === "once" || value.type === "interval" || value.type === "daily" || value.type === "cron") &&
    (value.delayMinutes === undefined ||
      (typeof value.delayMinutes === "number" && Number.isInteger(value.delayMinutes) &&
        value.delayMinutes >= 1 && value.delayMinutes <= 525_600)) &&
    (value.runAt === undefined || (typeof value.runAt === "string" && value.runAt.length <= 40)) &&
    (value.intervalMinutes === undefined ||
      (typeof value.intervalMinutes === "number" && Number.isInteger(value.intervalMinutes) &&
        value.intervalMinutes >= 1 && value.intervalMinutes <= 525_600)) &&
    (value.durationMinutes === undefined ||
      (typeof value.durationMinutes === "number" && Number.isInteger(value.durationMinutes) &&
        value.durationMinutes >= 1 && value.durationMinutes <= 525_600)) &&
    (value.timeOfDay === undefined || (typeof value.timeOfDay === "string" && value.timeOfDay.length <= 5)) &&
    (value.timeZone === undefined || (typeof value.timeZone === "string" && value.timeZone.length <= 100)) &&
    (value.cron === undefined || (typeof value.cron === "string" && value.cron.length <= 100))
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function hasValidDuration(duration: unknown, endsAt: unknown): boolean {
  if (duration === undefined) return endsAt === undefined;
  return (
    typeof duration === "number" &&
    Number.isInteger(duration) &&
    duration >= 1 &&
    duration <= 525_600 &&
    typeof endsAt === "number" &&
    Number.isFinite(endsAt)
  );
}

export function isSchedule(value: unknown): value is Schedule {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "once":
      return (
        typeof value.runAt === "number" &&
        Number.isFinite(value.runAt) &&
        (value.timeZone === undefined || isTimeZone(value.timeZone))
      );
    case "interval":
      return (
        isPositiveInteger(value.intervalMinutes) &&
        value.intervalMinutes <= 525_600 &&
        hasValidDuration(value.durationMinutes, value.endsAt)
      );
    case "daily":
      return (
        typeof value.timeOfDay === "string" &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(value.timeOfDay) &&
        isTimeZone(value.timeZone) &&
        hasValidDuration(value.durationMinutes, value.endsAt)
      );
    case "cron":
      return (
        typeof value.expression === "string" &&
        value.expression.trim().split(/\s+/).length === 5 &&
        isTimeZone(value.timeZone) &&
        hasValidDuration(value.durationMinutes, value.endsAt)
      );
    default:
      return false;
  }
}

function isScheduledWorkInput(value: unknown): value is ScheduledWorkInput {
  return (
    isRecord(value) &&
    (value.scheduleId === undefined ||
      (typeof value.scheduleId === "string" && value.scheduleId.length <= 200)) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 80 &&
    typeof value.prompt === "string" &&
    value.prompt.length > 0 &&
    value.prompt.length <= MAX_SCHEDULE_PROMPT_LENGTH &&
    isSchedule(value.schedule) &&
    typeof value.firstRunAt === "number" &&
    Number.isFinite(value.firstRunAt) &&
    typeof value.createdByCallId === "string" &&
    value.createdByCallId.length > 0 &&
    value.createdByCallId.length <= 1_024 &&
    isScheduledWorkTarget(value.target)
  );
}

export function isPausedSchedule(value: unknown): value is PausedSchedule {
  return (
    isRecord(value) &&
    typeof value.ownerKey === "string" &&
    value.ownerKey.length > 0 &&
    value.ownerKey.length <= 1_024 &&
    isScheduledWorkInput(value.input) && Boolean(value.input.scheduleId) &&
    typeof value.nextRunAt === "number" &&
    Number.isFinite(value.nextRunAt) &&
    typeof value.pausedAt === "number" &&
    Number.isFinite(value.pausedAt)
  );
}

function parseScheduledWorkCheckpoint(value: unknown): ScheduledWorkCheckpoint | undefined {
  if (!isRecord(value) || typeof value.phase !== "string" ||
    typeof value.runCount !== "number" || !Number.isSafeInteger(value.runCount) || value.runCount < 0) return undefined;
  if (value.phase === "wait") {
    return typeof value.nextAt === "number" && Number.isFinite(value.nextAt)
      ? { phase: "wait", nextAt: value.nextAt, runCount: value.runCount } : undefined;
  }
  if (typeof value.scheduledAt !== "number" || !Number.isFinite(value.scheduledAt)) return undefined;
  const common = { scheduledAt: value.scheduledAt, runCount: value.runCount };
  switch (value.phase) {
    case "run":
      return { phase: "run", ...common };
    case "deliver":
      // Version-one text-only deliveries are upgraded at the persistence boundary.
      return typeof value.text === "string"
        ? { phase: "delivery", ...common, response: { text: value.text, attachments: [] } } : undefined;
    case "delivery":
      return isAgentResponse(value.response) ? { phase: "delivery", ...common, response: value.response } : undefined;
    case "settle":
      return typeof value.deliveryTaskId === "number" && Number.isSafeInteger(value.deliveryTaskId)
        ? { phase: "settle", ...common, deliveryTaskId: value.deliveryTaskId } : undefined;
    default: return undefined;
  }
}

export function scheduledTaskState(value: unknown): ScheduledTaskStateView | undefined {
  if (!isRecord(value) || typeof value.status !== "string") return undefined;
  if (value.until !== undefined && (typeof value.until !== "number" || !Number.isFinite(value.until))) {
    return undefined;
  }
  let checkpoint = parseScheduledWorkCheckpoint(value.checkpoint);
  if (value.checkpoint !== undefined && value.checkpoint !== null && !checkpoint) return undefined;
  // Version one advanced to "run" before sleeping for the due time. Present it as waiting,
  // without confusing it with a run sleeping after an admission/transport attempt.
  if (value.status === "sleeping" && checkpoint?.phase === "run" && value.until === checkpoint.scheduledAt) {
    checkpoint = { phase: "wait", nextAt: checkpoint.scheduledAt, runCount: Math.max(0, checkpoint.runCount - 1) };
  }
  return {
    status: value.status,
    ...(typeof value.until === "number" ? { until: value.until } : {}),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}

function nextClockRun(schedule: ClockSchedule, after: number): number {
  let expression: string;
  if (schedule.type === "daily") {
    const [hour, minute] = schedule.timeOfDay.split(":").map(Number);
    expression = `${minute} ${hour} * * *`;
  } else {
    expression = schedule.expression;
  }
  const next = new Cron(expression, { timezone: schedule.timeZone }).nextRun(new Date(after));
  if (!next) throw new Error("The cron expression has no future run.");
  return next.getTime();
}

export function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new Error(`"${timeZone}" is not a valid time zone. Ask the user which city to use.`);
  }
}

function planSchedule(
  args: ScheduleArgs,
  now: number,
  storedTimeZone: string | undefined,
): { schedule: Schedule; firstRunAt: number } {
  if (args.type === "once") {
    if (args.durationMinutes !== undefined) {
      throw new Error("durationMinutes applies only to recurring schedules.");
    }
    const timeZone = args.timeZone?.trim() || storedTimeZone;
    if (timeZone) validateTimeZone(timeZone);
    if (args.delayMinutes !== undefined && args.runAt !== undefined) {
      throw new Error("For a one-time reminder, provide delayMinutes or runAt, not both.");
    }
    let runAt: number;
    if (args.delayMinutes !== undefined) {
      if (!Number.isInteger(args.delayMinutes) || args.delayMinutes < 1) {
        throw new Error("A one-time reminder delay must be at least one minute.");
      }
      runAt = now + args.delayMinutes * 60_000;
    } else {
      if (args.runAt && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(args.runAt)) {
        throw new Error("runAt must include an explicit UTC offset, such as Z or +05:30.");
      }
      runAt = args.runAt ? Date.parse(args.runAt) : Number.NaN;
      if (!Number.isFinite(runAt)) {
        throw new Error("For a one-time reminder, provide delayMinutes or an ISO-8601 runAt timestamp with an explicit UTC offset.");
      }
      if (runAt <= now) throw new Error("The reminder time must be in the future.");
    }
    return { schedule: { type: "once", runAt, ...(timeZone ? { timeZone } : {}) }, firstRunAt: runAt };
  }

  const duration = args.durationMinutes;
  if (duration !== undefined && (!Number.isInteger(duration) || duration < 1)) {
    throw new Error("A recurring schedule duration must be at least one minute.");
  }
  const durationFields: RecurringDuration = duration === undefined
    ? {}
    : { durationMinutes: duration, endsAt: now + duration * 60_000 };

  if (args.type === "interval") {
    const intervalMinutes = args.intervalMinutes;
    if (intervalMinutes === undefined || !Number.isInteger(intervalMinutes) || intervalMinutes < 1) {
      throw new Error("For an interval schedule, provide intervalMinutes (at least 1).");
    }
    const firstRunAt = now + intervalMinutes * 60_000;
    if (durationFields.endsAt !== undefined && firstRunAt > durationFields.endsAt) {
      throw new Error("The duration ends before the first run. Choose a longer duration or a shorter interval.");
    }
    return { schedule: { type: "interval", intervalMinutes, ...durationFields }, firstRunAt };
  }

  const timeZone = args.timeZone?.trim() || storedTimeZone;
  if (!timeZone) {
    throw new Error("Ask the user which city to use for their reminder times, save its time zone with set_schedule_timezone, then retry.");
  }
  validateTimeZone(timeZone);

  let schedule: ClockSchedule;
  if (args.type === "daily") {
    const timeOfDay = args.timeOfDay?.trim() ?? "";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeOfDay)) {
      throw new Error("For a daily schedule, timeOfDay must use 24-hour HH:MM format.");
    }
    schedule = { type: "daily", timeOfDay, timeZone, ...durationFields };
  } else {
    const expression = args.cron?.trim() ?? "";
    if (expression.split(/\s+/).length !== 5) {
      throw new Error("For a cron schedule, provide a five-field cron expression.");
    }
    schedule = { type: "cron", expression, timeZone, ...durationFields };
  }

  const firstRunAt = nextClockRun(schedule, now);
  if (schedule.endsAt !== undefined && firstRunAt > schedule.endsAt) {
    throw new Error("The duration ends before the first run. Choose a longer duration.");
  }
  return { schedule, firstRunAt };
}

export function normalizeSchedulePrompt(value: string): string {
  const prompt = value.trim();
  if (!prompt || prompt.length > MAX_SCHEDULE_PROMPT_LENGTH) {
    throw new Error(`Scheduled prompts must be between 1 and ${MAX_SCHEDULE_PROMPT_LENGTH} characters.`);
  }
  return prompt;
}

export function createScheduledWorkInput(
  args: ScheduleArgs,
  now: number,
  storedTimeZone: string | undefined,
  createdByCallId: string,
  target: ScheduledWorkTarget,
): ScheduledWorkInput & { scheduleId: string } {
  const prompt = normalizeSchedulePrompt(args.prompt);
  const { schedule, firstRunAt } = planSchedule(args, now, storedTimeZone);
  return {
    scheduleId: newScheduleId(),
    name: args.name?.trim().slice(0, 80) || prompt.slice(0, 60),
    prompt,
    schedule,
    firstRunAt,
    createdByCallId,
    target,
  };
}

export function nextRunAt(schedule: Schedule, previousRunAt: number, now: number): number | undefined {
  if (schedule.type === "once") return undefined;
  let next: number;
  if (schedule.type === "interval") {
    const intervalMs = schedule.intervalMinutes * 60_000;
    const missed = Math.max(0, Math.floor((now - previousRunAt) / intervalMs));
    next = previousRunAt + (missed + 1) * intervalMs;
  } else {
    next = nextClockRun(schedule, now);
  }
  return schedule.endsAt !== undefined && next > schedule.endsAt ? undefined : next;
}

function formatDuration(minutes: number): string {
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  return [
    days ? `${days} day${days === 1 ? "" : "s"}` : "",
    hours ? `${hours} hour${hours === 1 ? "" : "s"}` : "",
    remainingMinutes ? `${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" ");
}

export function describeFirstRun(schedule: Schedule, scheduledAt: number, delayMinutes?: number): string {
  if (schedule.type === "interval") return `in ${schedule.intervalMinutes} minutes`;
  if (schedule.type === "once" && delayMinutes !== undefined) return `in ${delayMinutes} minutes`;
  const timeZone = schedule.timeZone ?? "UTC";
  return new Date(scheduledAt).toLocaleString("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }) + (timeZone === "UTC" ? " UTC" : ` (${timeZone})`);
}

export function describeSchedule(schedule: Schedule): string {
  switch (schedule.type) {
    case "once":
      return `once at ${new Date(schedule.runAt).toLocaleString("en-US", {
        timeZone: schedule.timeZone ?? "UTC",
        dateStyle: "medium",
        timeStyle: "short",
      })}${schedule.timeZone ? ` (${schedule.timeZone})` : " (UTC)"}`;
    case "interval":
      return `every ${schedule.intervalMinutes} minute${schedule.intervalMinutes === 1 ? "" : "s"}${schedule.durationMinutes ? ` for ${formatDuration(schedule.durationMinutes)}` : ""}`;
    case "daily":
      return `daily at ${schedule.timeOfDay} (${schedule.timeZone})${schedule.durationMinutes ? ` for ${formatDuration(schedule.durationMinutes)}` : ""}`;
    case "cron":
      return `cron "${schedule.expression}" (${schedule.timeZone})${schedule.durationMinutes ? ` for ${formatDuration(schedule.durationMinutes)}` : ""}`;
  }
}

export function scheduleInput(value: unknown): ScheduledWorkInput | undefined {
  if (!isScheduledWorkInput(value)) return undefined;
  return {
    ...(value.scheduleId ? { scheduleId: value.scheduleId } : {}),
    name: value.name,
    prompt: value.prompt,
    schedule: value.schedule,
    firstRunAt: value.firstRunAt,
    createdByCallId: value.createdByCallId,
    target: {
      ...value.target,
      scope: { kind: value.target.scope.kind, id: value.target.scope.id },
      destination: { ...value.target.destination },
    },
  };
}

export function publicScheduleId(input: ScheduledWorkInput, taskId: number): string {
  return input.scheduleId || String(taskId);
}

export function newScheduleId(): string {
  return `s-${randomUUID()}`;
}

