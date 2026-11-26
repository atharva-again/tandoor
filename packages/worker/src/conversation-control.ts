import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  UsageDoc,
  type Conversation,
  type Harness,
} from "@earendil-works/pi-durable";
import type { createModels } from "@earendil-works/pi-ai/models";
import type { ConversationAction } from "../../shared/src/grpc.js";

export interface ConversationControlOptions {
  harness: Harness;
  models: ReturnType<typeof createModels>;
  workspace: string;
}

function markdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function formatMarkdownTable(headers: [string, string], rows: Array<[string, string]>): string {
  return [
    `| ${headers.map(markdownTableCell).join(" | ")} |`,
    "| --- | --- |",
    ...rows.map((row) => `| ${row.map(markdownTableCell).join(" | ")} |`),
  ].join("\n");
}

async function sessionSummary(
  options: ConversationControlOptions,
  conversation: Conversation,
): Promise<string> {
  const [agent, view, usage] = await Promise.all([
    conversation.agent(BACKGROUND_CONTEXT),
    conversation.context(BACKGROUND_CONTEXT),
    options.harness.snapshot(UsageDoc, conversation.id, BACKGROUND_CONTEXT),
  ]);

  const counts = { users: 0, assistants: 0, toolCalls: 0, toolResults: 0, total: 0 };
  let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
  do {
    const page = await conversation.entries(
      { order: "ascending" },
      500,
      cursor,
      BACKGROUND_CONTEXT,
    );
    for (const entry of page.items) {
      for (const message of entry.model ?? []) {
        if (message.role === "user") {
          counts.users++;
          counts.total++;
        } else if (message.role === "assistant") {
          counts.assistants++;
          counts.total++;
          counts.toolCalls += message.content.filter((part) => part.type === "toolCall").length;
        } else if (message.role === "toolResult") {
          counts.toolResults++;
          counts.total++;
        }
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);

  const tokenTotals = Object.values(usage?.models ?? {}).reduce(
    (total, current) => ({
      input: total.input + current.input,
      output: total.output + current.output,
      cacheRead: total.cacheRead + current.cacheRead,
      cacheWrite: total.cacheWrite + current.cacheWrite,
      cost: total.cost + current.cost.total,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  );
  const totalTokens =
    tokenTotals.input + tokenTotals.output + tokenTotals.cacheRead + tokenTotals.cacheWrite;
  const model = agent.model
    ? options.models.getModel(agent.model.provider, agent.model.modelId)
    : undefined;
  const contextTokens = estimateContextTokens(view.messages).tokens;
  const contextWindow = model?.contextWindow;
  const scope = "Telegram private chat";
  const sessionRows: Array<[string, string]> = [
    ["ID", String(conversation.id)],
    ["Storage", "conversations.sqlite (SQLite)"],
    ["Scope", scope],
  ];
  const messageRows: Array<[string, string]> = [
    ["User", counts.users.toLocaleString()],
    ["Assistant", counts.assistants.toLocaleString()],
    ["Tool calls", counts.toolCalls.toLocaleString()],
    ["Tool results", counts.toolResults.toLocaleString()],
    ["Total", counts.total.toLocaleString()],
  ];
  const tokenRows: Array<[string, string]> = [
    ["Input", tokenTotals.input.toLocaleString()],
    ["Output", tokenTotals.output.toLocaleString()],
  ];
  if (tokenTotals.cacheRead > 0) tokenRows.push(["Cache read", tokenTotals.cacheRead.toLocaleString()]);
  if (tokenTotals.cacheWrite > 0) tokenRows.push(["Cache write", tokenTotals.cacheWrite.toLocaleString()]);
  tokenRows.push(["Total", totalTokens.toLocaleString()]);
  if (tokenTotals.cost > 0) tokenRows.push(["Recorded cost", `$${tokenTotals.cost.toFixed(4)}`]);
  const runtimeRows: Array<[string, string]> = [
    ["Model", model ? `${model.provider}/${model.id}` : "none"],
    ["Thinking", agent.thinkingLevel ?? "unknown"],
    ["Workspace", options.workspace],
    [
      "Context",
      contextWindow
        ? `~${contextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${((contextTokens / contextWindow) * 100).toFixed(1)}%)`
        : `~${contextTokens.toLocaleString()} tokens`,
    ],
  ];
  return [
    "**Session**",
    "",
    formatMarkdownTable(["Field", "Value"], sessionRows),
    "",
    "**Messages**",
    "",
    formatMarkdownTable(["Type", "Count"], messageRows),
    "",
    "**Tokens**",
    "",
    formatMarkdownTable(["Type", "Count"], tokenRows),
    "",
    "**Runtime**",
    "",
    formatMarkdownTable(["Setting", "Value"], runtimeRows),
  ].join("\n");
}

export async function controlConversation(
  options: ConversationControlOptions,
  conversation: Conversation,
  action: ConversationAction,
  instructions: string,
): Promise<string> {
  if (action === "session") return sessionSummary(options, conversation);
  if (action === "reset") {
    await conversation.reset(instructions.trim() || undefined, BACKGROUND_CONTEXT);
    return "Started a fresh conversation.";
  }
  if (action === "abort") {
    await conversation.abort(BACKGROUND_CONTEXT);
    return "Stopped the current run.";
  }
  if (action === "compact") {
    const taskId = await conversation.compact(instructions.trim() || undefined, BACKGROUND_CONTEXT);
    const settled = await options.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    if (settled.state.status !== "terminal") throw new Error("Compaction did not settle.");
    if (settled.state.outcome.status !== "completed") {
      const outcome = settled.state.outcome;
      throw new Error("error" in outcome ? outcome.error.message : "Compaction did not complete.");
    }
    return settled.state.outcome.result.entryId === undefined
      ? "There is nothing to compact yet."
      : "Conversation context compacted.";
  }
  throw new Error(`Unsupported conversation action: ${action}`);
}
