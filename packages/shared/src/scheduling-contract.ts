import { isRecord } from "./schedule-model.js";

export function parseScheduleCreated(value: unknown) {
  if (
    !isRecord(value) || typeof value.scheduleId !== "string" || typeof value.name !== "string" ||
    typeof value.firstRunAt !== "number" || typeof value.firstRunDescription !== "string" ||
    typeof value.schedule !== "string"
  ) throw new Error("The scheduler returned invalid schedule details.");
  return {
    scheduleId: value.scheduleId, name: value.name, firstRunAt: value.firstRunAt,
    firstRunDescription: value.firstRunDescription, schedule: value.schedule,
  };
}

export function parseScheduleText(value: unknown) {
  if (!isRecord(value) || typeof value.text !== "string") {
    throw new Error("The scheduler returned an invalid result.");
  }
  return { text: value.text };
}

export function parseScheduleTimeZone(value: unknown) {
  if (
    !isRecord(value) || typeof value.timeZone !== "string" ||
    (value.city !== undefined && typeof value.city !== "string")
  ) throw new Error("The scheduler returned an invalid time zone.");
  return { timeZone: value.timeZone, ...(typeof value.city === "string" ? { city: value.city } : {}) };
}
