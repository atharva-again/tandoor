import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import {
  UsageDoc,
  type Conversation,
  type Harness,
} from "@earendil-works/pi-durable";
import type { ConversationAction } from "../../shared/src/grpc.js";
import type { FileCredentialStore } from "./auth/credential-store.js";
import type { ConversationModelSettingsStore } from "./model-settings.js";
import { getAvailableOAuthModels, OAUTH_MODEL_PROVIDERS } from "./model-catalog.js";

export interface ConversationControlOptions {
  harness: Harness;
  models: Parameters<typeof getAvailableOAuthModels>[0];
  credentials: Pick<FileCredentialStore, "list">;
  modelSettings: ConversationModelSettingsStore;
  workspace: string;
  isLoginInProgress(providerId: string): boolean;
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
  key: string,
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
  if (action === "model") {
    const requested = instructions.trim();
    if (!requested) {
      const model = (await conversation.agent(BACKGROUND_CONTEXT)).model;
      return model
        ? `Current model: ${model.provider}/${model.modelId}. Set one with /model provider/model-id.`
        : "No model is configured.";
    }
    const separator = requested.indexOf("/");
    if (separator < 1 || separator === requested.length - 1) {
      throw new Error("Use /model provider/model-id, for example /model openai/gpt-6-luna.");
    }
    const provider = requested.slice(0, separator);
    const modelId = requested.slice(separator + 1);
    const { models } = await getAvailableOAuthModels(options.models, options.credentials);
    const model = models.find((candidate) => candidate.provider === provider && candidate.id === modelId);
    if (!model) {
  throw new Error(`Model unavailable: ${provider}/${modelId}. Sign in with /login_provider, then choose a model with /model.`);
    }
    await conversation.configure({ model: { provider, modelId } }, BACKGROUND_CONTEXT);
    return `Model set to ${provider}/${modelId}.`;
  }
  if (action === "logout") {
    const providerId = instructions.trim();
    if (!OAUTH_MODEL_PROVIDERS.has(providerId)) {
      throw new Error("Choose an OAuth provider shown in /logout_provider.");
    }
    if (options.isLoginInProgress(providerId)) {
      throw new Error("A login for this provider is still in progress. Cancel it before signing out.");
    }
    await options.models.logout(providerId);
    return `Signed out of ${providerId}.`;
  }
  if (action === "set_scoped_models") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(instructions);
    } catch {
      throw new Error("Scoped models must be a JSON array of provider/model references.");
    }
    if (!Array.isArray(parsed)) throw new Error("Scoped models must be a JSON array.");
    const { models: availableModels } = await getAvailableOAuthModels(options.models, options.credentials);
    const references: Array<{ provider: string; modelId: string }> = [];
    for (const item of parsed) {
      if (
        typeof item !== "object" ||
        item === null ||
        !("provider" in item) ||
        typeof item.provider !== "string" ||
        !("modelId" in item) ||
        typeof item.modelId !== "string"
      ) {
        throw new Error("Each scoped model must include a provider and modelId.");
      }
      const model = availableModels.find(
        (candidate) => candidate.provider === item.provider && candidate.id === item.modelId,
      );
      if (!model) {
        throw new Error(`Model unavailable: ${item.provider}/${item.modelId}. Sign in first.`);
      }
      references.push({ provider: item.provider, modelId: item.modelId });
    }
    const saved = await options.modelSettings.setScopedModels(key, references);
    return saved.length === 0
      ? "Scoped model list cleared."
      : `Scoped model list saved with ${saved.length} model(s).`;
  }
  if (action === "thinking") {
    const requested = instructions.trim().toLowerCase();
    const agent = await conversation.agent(BACKGROUND_CONTEXT);
    if (!requested) return `Thinking level: ${agent.thinkingLevel ?? "off"}.`;
    const model = agent.model
      ? options.models.getModel(agent.model.provider, agent.model.modelId)
      : undefined;
    const levels = model ? getSupportedThinkingLevels(model) : ["off"];
    if (!levels.includes(requested as (typeof levels)[number])) {
      throw new Error(`Unsupported thinking level for the current model. Choose one of: ${levels.join(", ")}.`);
    }
    await conversation.configure(
      { thinkingLevel: requested as NonNullable<typeof agent.thinkingLevel> },
      BACKGROUND_CONTEXT,
    );
    return `Thinking level set to ${requested}.`;
  }
  throw new Error(`Unsupported conversation action: ${action}`);
}
