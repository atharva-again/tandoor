import type { IntegrationRequest } from "../../shared/src/grpc.js";
import {
  describeFirstRun,
  describeSchedule,
  isRecord,
  isScheduleArgs,
  type ScheduledWorkOwner,
  type ScheduledWorkTarget,
} from "../../shared/src/schedule-model.js";
import {
  conversationKey,
  type TelegramMessageIdentity,
  type WorkerScope,
  workerScope,
} from "../../shared/src/scope.js";
import type { ScheduleService, ScheduleActionResult, ScheduleSummary } from "./schedule-service.js";

export interface TelegramSchedulingIntegrationOptions {
  prepareTarget(target: ScheduledWorkTarget): Promise<void>;
  service: ScheduleService;
}

function validActorId(value: string): boolean {
  const id = Number(value);
  return /^\d{1,20}$/.test(value) && Number.isSafeInteger(id) && id > 0;
}

function recordFromJson(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("The scheduling request is invalid.");
  }
  if (!isRecord(parsed)) throw new Error("The scheduling request is invalid.");
  return parsed;
}

function targetForRequest(
  sourceScope: WorkerScope,
  request: IntegrationRequest,
  payload: Record<string, unknown>,
): ScheduledWorkTarget {
  const actorId = request.actorId;
  if (!validActorId(actorId)) throw new Error("The Telegram sender could not be verified.");
  if (sourceScope.id !== actorId) {
    throw new Error("Schedules can only be managed by their Telegram owner.");
  }
  const senderName = typeof payload.senderName === "string"
    ? payload.senderName.slice(0, 200)
    : "You";
  const chatId = typeof payload.chatId === "string" ? payload.chatId : "";
  const threadId = typeof payload.threadId === "string" ? payload.threadId : "";
  const channel = typeof payload.channel === "string" ? payload.channel : "";
  if (
    !/^\d{1,20}$/.test(chatId) ||
    (threadId !== "" && (!/^\d{1,20}$/.test(threadId) || Number(threadId) <= 0)) ||
    payload.chatType !== "private" ||
    !channel ||
    channel.length > 100
  ) {
    throw new Error("The scheduling request destination is invalid.");
  }
  const identity: TelegramMessageIdentity = {
    chatId: Number(chatId),
    senderId: Number(actorId),
    chatType: "private",
    ...(threadId ? { threadId: Number(threadId) } : {}),
  };
  if (
    !Number.isSafeInteger(identity.chatId) ||
    !Number.isSafeInteger(identity.senderId) ||
    (identity.threadId !== undefined && !Number.isSafeInteger(identity.threadId)) ||
    identity.chatId !== identity.senderId ||
    conversationKey(identity) !== request.conversationKey ||
    String(identity.chatId) !== sourceScope.id
  ) {
    throw new Error("The scheduling request does not match its Telegram conversation.");
  }
  return {
    clientId: "telegram",
    scope: sourceScope,
    actorId,
    senderName,
    conversationKey: request.conversationKey,
    channel,
    destination: { chatId, threadId, chatType: "private" },
  };
}

function formatScheduleRows(schedules: readonly ScheduleSummary[]): string {
  if (schedules.length === 0) return "You have no scheduled work in this chat.";
  return schedules.map((item) =>
    `${item.id} · ${item.name} · ${describeSchedule(item.schedule)} · ${item.status}` +
    (item.nextAt === undefined ? "" : ` · next ${new Date(item.nextAt).toISOString()}`) +
    (item.retryAt === undefined ? "" : ` · delivery retry ${new Date(item.retryAt).toISOString()}`),
  ).join("\n");
}

function describeAction(result: ScheduleActionResult): string {
  switch (result.action) {
    case "cancel":
      return result.status === "cancelled"
        ? `Cancelled schedule "${result.name}".`
        : `Schedule "${result.name}" has already finished.`;
    case "pause":
      return result.status === "paused"
        ? `Paused "${result.name}". It will resume at its next scheduled time when resumed.`
        : `Schedule "${result.name}" is already paused.`;
    case "resume":
      return `Resumed "${result.name}". Schedule ID: ${result.scheduleId}.`;
  }
}

export class TelegramSchedulingIntegration {
  constructor(private readonly options: TelegramSchedulingIntegrationOptions) {}

  async execute(
    sourceScope: WorkerScope,
    request: IntegrationRequest,
  ): Promise<unknown> {
    const service = this.options.service;
    if (request.integrationId !== "tandoor_scheduling") {
      throw new Error("Unsupported scheduling integration.");
    }
    const payload = recordFromJson(request.payloadJson);
    const target = targetForRequest(sourceScope, request, payload);

    switch (request.operation) {
      case "create": {
        if (!isScheduleArgs(payload.args) || typeof payload.callId !== "string") {
          throw new Error("The schedule details are invalid.");
        }
        const args = payload.args;
        await this.options.prepareTarget(target);
        const created = await service.createSchedule(
          target,
          args,
          payload.callId,
        );
        return {
          ...created,
          schedule: describeSchedule(created.schedule),
          firstRunDescription: describeFirstRun(
            created.schedule,
            created.firstRunAt,
            args.delayMinutes,
          ),
        };
      }
      case "list":
        return {
          text: formatScheduleRows(await service.listSchedules(target)),
        };
      case "cancel":
      case "pause":
      case "resume":
        if (typeof payload.schedule !== "string" || !payload.schedule.trim()) {
          throw new Error("A schedule ID or name is required.");
        }
        return {
          text: describeAction(
            await service.manageSchedule(request.operation, target, payload.schedule.trim()),
          ),
        };
      case "set_timezone": {
        if (typeof payload.timeZone !== "string") throw new Error("A time zone is required.");
        const timeZone = payload.timeZone.trim();
        const city = typeof payload.city === "string" ? payload.city.trim().slice(0, 100) : "";
        const saved = await service.setTimeZone(target, timeZone, city || timeZone);
        return { timeZone: saved.timeZone, ...(city ? { city: saved.label } : {}) };
      }
      default:
        throw new Error(`Unsupported scheduling operation: ${request.operation}`);
    }
  }

  async command(
    scope: WorkerScope,
    identity: TelegramMessageIdentity,
    instructions: string,
  ): Promise<string> {
    const service = this.options.service;
    const actualScope = workerScope(identity);
    if (actualScope.id !== scope.id) {
      throw new Error("The scheduled command does not match this Telegram conversation.");
    }
    const owner: ScheduledWorkOwner = {
      clientId: "telegram",
      conversationKey: conversationKey(identity),
      scope: actualScope,
    };
    const [action = "", ...rest] = instructions.trim().split(/\s+/);
    const query = rest.join(" ").trim();
    if (!action) {
      return formatScheduleRows(await service.listSchedules(owner));
    }
    if (action !== "cancel" || !query) {
      return "Use /scheduled to list work, or /scheduled cancel <ID> to cancel it.";
    }
    return describeAction(await service.manageSchedule("cancel", owner, query));
  }
}
