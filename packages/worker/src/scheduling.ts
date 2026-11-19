import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { telegramContextForRun } from "./actor-context.js";
import type { GatewayIntegrationClient } from "./integration-client.js";
import { parseScheduleCreated, parseScheduleText, parseScheduleTimeZone } from "../../shared/src/scheduling-contract.js";
import { MAX_SCHEDULE_PROMPT_LENGTH, type ScheduleArgs } from "../../shared/src/schedule-model.js";
import {
  defineExtension,
  defineTool,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";

export interface SchedulingOptions {
  integrationClient: GatewayIntegrationClient;
}

const scheduleParameters = obj({
  name: opt(str({
    minLength: 1,
    maxLength: 80,
    description: "Short unique name for this schedule, such as daily-brief or hourly-jobs.",
  })),
  prompt: str({
    minLength: 1,
    maxLength: MAX_SCHEDULE_PROMPT_LENGTH,
    description: "The work the agent should perform on each scheduled run. Preserve the user's requested task faithfully.",
  }),
  type: oneOf(["once", "interval", "daily", "cron"] as const, {
    description: "Use once for a reminder, interval for elapsed-time repeats, daily for a local wall-clock time, or cron for a cron expression.",
  }),
  delayMinutes: opt(int({
    minimum: 1,
    maximum: 525_600,
    description: "For a one-time reminder, minutes from now. Prefer this for relative requests such as 'in 5 minutes'.",
  })),
  runAt: opt(str({
    maxLength: 40,
    description: "For a one-time reminder at a specific date/time, an ISO-8601 timestamp with an explicit UTC offset.",
  })),
  intervalMinutes: opt(int({
    minimum: 1,
    maximum: 525_600,
    description: "For interval schedules, minutes between runs. For example, 60 means hourly. Describe the first run relatively; do not invent a local wall-clock time.",
  })),
  durationMinutes: opt(int({
    minimum: 1,
    maximum: 525_600,
    description: "For a recurring schedule, how long it should continue from creation. Set this when the user gives a duration or end window; do not promise a cutoff unless it is set.",
  })),
  timeOfDay: opt(str({
    maxLength: 5,
    description: "For daily schedules, local 24-hour time HH:MM, such as 10:00.",
  })),
  timeZone: opt(str({
    maxLength: 100,
    description: "IANA time zone for daily and cron schedules. Use the user's saved zone; if none is saved, ask which city to use, resolve its IANA zone, and save it with set_schedule_timezone. Never assume the server's time zone.",
  })),
  cron: opt(str({
    maxLength: 100,
    description: "For cron schedules, a five-field cron expression such as 0 10 * * 1-5.",
  })),
});

const scheduleActionParameters = obj({
  schedule: str({
    minLength: 1,
    maxLength: 100,
    description: "Schedule ID or unique schedule name returned by list_scheduled_work.",
  }),
});

const listParameters = obj({});

const timeZoneParameters = obj({
  timeZone: str({
    minLength: 1,
    maxLength: 100,
    description: "IANA time zone resolved from the user's city, for example Asia/Kolkata.",
  }),
  city: opt(str({
    maxLength: 100,
    description: "The city the user gave, used only as a friendly label.",
  })),
});

type ScheduleActionArgs = { schedule: string };
type ListArgs = Record<string, never>;
type TimeZoneArgs = { timeZone: string; city?: string };

export function createSchedulingExtension(options: SchedulingOptions) {
  async function call<T>(
    operation: string,
    payload: Record<string, unknown>,
    api: ToolExecutionApi,
    context: Context,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const telegram = await telegramContextForRun(api, context);
    return options.integrationClient.execute<T>(
      telegram,
      "tandoor_scheduling",
      operation,
      {
        ...payload,
        actorId: telegram.actorId,
        senderName: telegram.senderName,
        conversationKey: telegram.conversationKey,
        chatId: telegram.chatId,
        threadId: telegram.threadId,
        chatType: "private",
        channel: telegram.channel,
      },
      parse,
      context.abortSignal,
    );
  }

  const createSchedule = defineTool({
    name: "schedule_work",
    description:
      "Create a one-time reminder or recurring agent work in this private chat. Preserve the requested task. Use the saved time zone for local clock times; ask which city to use if none is saved, and ask about a time only when context does not resolve its ambiguity. For a specific date/time use an ISO timestamp with an explicit UTC offset; for relative times, confirm using relative wording rather than presenting UTC/server time as local time.",
    parameters: scheduleParameters,
    replay: "safe",
    executionMode: "sequential",
    async execute(args: ScheduleArgs, api, context) {
      const result = await call("create", { args, callId: api.callId }, api, context, parseScheduleCreated);
      return {
        output: [{
          type: "text" as const,
          text: `Saved "${result.name}" (${result.schedule}). First run: ${result.firstRunDescription}. Schedule ID: ${result.scheduleId}.`,
        }],
        details: {
          scheduleId: result.scheduleId,
          nextRunAt: result.firstRunAt,
          schedule: result.schedule,
        },
      };
    },
  });

  const listSchedules = defineTool({
    name: "list_scheduled_work",
    description: "List one-time reminders and recurring agent work, including status and next run. Work queues behind a busy worker, overdue work runs when it returns online, and missed recurring runs are coalesced rather than replayed in a burst.",
    parameters: listParameters,
    replay: "safe",
    async execute(_args: ListArgs, api, context) {
      const result = await call(
        "list",
        {},
        api,
        context,
        parseScheduleText,
      );
      return { output: [{ type: "text" as const, text: result.text }] };
    },
  });

  function actionTool(
    name: "cancel_scheduled_work" | "pause_scheduled_work" | "resume_scheduled_work",
    operation: "cancel" | "pause" | "resume",
    description: string,
  ) {
    return defineTool({
      name,
      description,
      parameters: scheduleActionParameters,
      replay: "safe",
      executionMode: "sequential",
      async execute(args: ScheduleActionArgs, api, context) {
        const result = await call(
          operation,
          { schedule: args.schedule.trim() },
          api,
          context,
          parseScheduleText,
        );
        return { output: [{ type: "text" as const, text: result.text }] };
      },
    });
  }

  const setScheduleTimeZone = defineTool({
    name: "set_schedule_timezone",
    description:
      "After asking which city to use, resolve it to an IANA time zone and save it for future daily and cron schedules. Never silently use the server's time zone.",
    parameters: timeZoneParameters,
    replay: "safe",
    executionMode: "sequential",
    async execute(args: TimeZoneArgs, api, context) {
      const result = await call(
        "set_timezone",
        { timeZone: args.timeZone, city: args.city },
        api,
        context,
        parseScheduleTimeZone,
      );
      return {
        output: [{
          type: "text" as const,
          text: `Saved ${result.timeZone} as your reminder time zone${result.city ? ` (${result.city})` : ""}.`,
        }],
        details: result,
      };
    },
  });

  return defineExtension({
    name: "tandoor-scheduling",
    tools: [
      createSchedule,
      listSchedules,
      actionTool(
        "cancel_scheduled_work",
        "cancel",
        "Cancel one scheduled task by its ID or unique name.",
      ),
      actionTool(
        "pause_scheduled_work",
        "pause",
        "Pause a scheduled task without deleting it. It can later be resumed with resume_scheduled_work.",
      ),
      actionTool(
        "resume_scheduled_work",
        "resume",
        "Resume a paused schedule. If its next run time has passed, it runs once immediately.",
      ),
      setScheduleTimeZone,
    ],
  });
}
