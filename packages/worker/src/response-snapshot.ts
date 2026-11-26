import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  defineDocFamily,
  defineExtension,
  defineTask,
  GenerationTask,
  hook,
  runEndTask,
  type Cursor,
  type EntryRecord,
  type EntryId,
  type HookApi,
  type RunSummary,
} from "@earendil-works/pi-durable";
import { storeAttachment, type AgentResponse } from "../../shared/src/agent-response.js";
import { extractWorkspaceMedia } from "./media.js";

export const MessageResponse = defineDocFamily<{
  response: AgentResponse | null;
  advanceAfterStop: boolean;
}, null>({
  kind: "tandoor.message-response",
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ response: null, advanceAfterStop: false }),
  checkpointWhen: () => false,
});

function requestIdFromEntry(entry: EntryRecord): string | undefined {
  if (
    entry.kind !== "tandoor.telegram.input" ||
    typeof entry.data !== "object" ||
    entry.data === null ||
    Array.isArray(entry.data)
  ) {
    return undefined;
  }
  const requestId = entry.data.requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
}

function answerText(entry: EntryRecord | undefined): string {
  if (!entry) throw new Error("The completed answer is missing.");
  const assistant = entry.model?.[0];
  if (!assistant || assistant.role !== "assistant") throw new Error("The completed answer is invalid.");
  return assistant.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("").trim();
}

function createAnswerSnapshotTask(workspace: string) {
  return defineTask<
    { requestId: string; answer: EntryId },
    { phase: "snapshot" },
    null
  >({
    name: "tandoor.message-response-snapshot",
    version: 1,
    initial: () => ({ phase: "snapshot" }),
    phases: {
      snapshot: async (task, runtime, context) => {
        const existing = await runtime.snapshot(MessageResponse, task.conversationId, task.input.requestId, context);
        if (existing?.response) {
          await runtime.commit(() => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }), context);
          return;
        }

        const text = answerText(await runtime.entry(AssistantEntry, task.input.answer, context));
        const media = await extractWorkspaceMedia(text, workspace);
        const response: AgentResponse = {
          text: [
            media.text.trim(),
            ...media.errors.map((error) => `File delivery failed: ${error}`),
          ].filter(Boolean).join("\n\n"),
          attachments: media.attachments.map(storeAttachment),
        };
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(MessageResponse, task.conversationId, task.input.requestId, null);
          doc.response ??= response;
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({
        status: "terminal",
        outcome: { status: "aborted" },
      }), context);
    },
  });
}

async function snapshotRunResponses(
  run: RunSummary,
  api: HookApi,
  context: Context,
  task: ReturnType<typeof createAnswerSnapshotTask>,
) {
  const requests: string[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await api.entries(
      { minEntryId: run.first, maxEntryId: run.answer, order: "ascending" },
      100,
      cursor,
      context,
    );
    for (const entry of page.items) {
      const requestId = requestIdFromEntry(entry);
      if (requestId) requests.push(requestId);
    }
    cursor = page.next;
  } while (cursor !== undefined);

  return {
    tasks: requests.map((requestId) =>
      runEndTask(task, { requestId, answer: run.answer }),
    ),
  };
}

export function createResponseSnapshotExtension(workspace: string) {
  const task = createAnswerSnapshotTask(workspace);
  return defineExtension({
    name: "tandoor-response-snapshots",
    tasks: [task],
    hooks: [hook(GenerationTask, {
      afterRun: (run, api, context) => snapshotRunResponses(run, api, context, task),
    })],
  });
}
