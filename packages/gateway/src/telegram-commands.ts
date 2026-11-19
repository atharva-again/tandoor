import type { Context } from "grammy";
import type { ConversationAction } from "../../shared/src/grpc.js";
import { conversationKey, workerScope, type TelegramMessageIdentity } from "../../shared/src/scope.js";
import { sendRichMarkdownMessage } from "./telegram-message-formatting.js";
import { unary, type ConnectWorker } from "./worker-client.js";
import type { TelegramUI } from "./telegram-ui.js";
import type { TelegramProviderAuth } from "./telegram-provider-auth.js";
import type { TelegramGoogleAuth } from "./telegram-google-auth.js";
import type { TelegramModelPickers } from "./telegram-model-pickers.js";
import type { TelegramSchedulingIntegration } from "./telegram-scheduling-integration.js";

export const TELEGRAM_COMMANDS = [
  { command: "start", description: "Start Tandoor" },
  { command: "help", description: "Show Help" },
  { command: "new", description: "Start A Fresh Conversation" },
  { command: "compact", description: "Compact Conversation Context" },
  { command: "abort", description: "Stop The Current Run" },
  { command: "session", description: "Show Session Details And Usage" },
  { command: "scheduled", description: "View Or Cancel Scheduled Work" },
  { command: "model", description: "Pick Or Set The Current Model" },
  { command: "scoped_models", description: "Choose Or Edit Scoped Models" },
  { command: "login_provider", description: "Connect OpenAI, Codex, Or Grok/X" },
  { command: "login_google", description: "Connect A Google Account" },
  { command: "logout_google", description: "Disconnect A Google Account" },
  { command: "logout_provider", description: "Disconnect A Provider Account" },
  { command: "cancel_login", description: "Cancel An OAuth Login" },
  { command: "thinking", description: "Pick Or Set Thinking Level" },
];

export class TelegramCommands {
  constructor(private readonly options: {
    ui: TelegramUI;
    connectWorker: ConnectWorker;
    providers: TelegramProviderAuth;
    google: TelegramGoogleAuth;
    models: TelegramModelPickers;
    scheduling: TelegramSchedulingIntegration;
    googleLoginEnabled: boolean;
  }) {}

  async handle(
    ctx: Context, identity: TelegramMessageIdentity, command: { name: string; args: string },
  ): Promise<boolean> {
    const { ui, connectWorker, providers, google, models, scheduling } = this.options;
    const { name, args } = command;
    const key = conversationKey(identity);
    const reply = (text: string) => ui.reply(ctx, identity, text);
    const worker = () => connectWorker(workerScope(identity));
    const control = async (action: ConversationAction) => {
      const client = await worker();
      return unary(client, "controlConversation", { conversationKey: key, action, instructions: args });
    };
    const handlers: Record<string, () => Promise<void>> = {
      start: () => reply("Hi! I’m Tandoor, your AI assistant in Telegram. Send a question, file, image, or a task to schedule.\n\nConnect an AI provider with /login_provider. Connect Google Workspace with /login_google. Use /help for commands."),
      help: () => reply(["Send Tandoor a private message to chat.", "", ...TELEGRAM_COMMANDS.map((item) => `/${item.command}: ${item.description}`)].join("\n")),
      scheduled: async () => reply(await scheduling.command(workerScope(identity), identity, args)),
      model: async () => {
        const client = await worker();
        if (!args) return models.showModelProviders(identity, client, key);
        const result = await control("model");
        if (!result.accepted) return reply(result.message);
        await models.showThinkingPicker(identity, client, key, undefined, "model", "Model Selected.");
      },
      thinking: async () => {
        if (!args) return models.showThinkingPicker(identity, await worker(), key);
        const result = await control("thinking");
        await reply(result.message);
      },
      scoped_models: async () => models.showScopedModels(identity, await worker(), key),
      login_provider: async () => providers.showLoginPicker(identity, await worker()),
      logout_provider: async () => providers.showLogoutPicker(identity, await worker()),
      login_google: async () => {
        if (!this.options.googleLoginEnabled) {
          await reply("Google sign in needs TANDOOR_GOOGLE_OAUTH_WEB_CLIENT_FILE configured. Restart Tandoor after setting it.");
        } else {
          await google.beginGoogleLoginPrompt(identity, await worker());
        }
      },
      logout_google: async () => google.showGoogleLogoutAccounts(identity),
      cancel_login: () => reply("No login is waiting for input. Use /login_provider or /login_google to start one."),
    };
    const actions: Record<string, ConversationAction> = { new: "reset", compact: "compact", abort: "abort", session: "session" };
    const action = actions[name];
    if (!handlers[name] && !action) return false;
    try {
      if (action) {
        const result = await control(action);
        if (result.accepted && action === "session") await sendRichMarkdownMessage(ctx, identity, result.message);
        else await reply(result.accepted ? result.message : `Tandoor: ${result.message}`);
      } else {
        await handlers[name]!();
      }
    } catch (error) {
      await reply(`Tandoor: ${error instanceof Error ? error.message : "The command failed."}`);
    }
    return true;
  }
}
