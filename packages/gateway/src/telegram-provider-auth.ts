import type { Context } from "grammy";
import type { WireOAuthLoginEvent, WorkerClient } from "../../shared/src/grpc.js";
import { decodeEvent, workerMetadata } from "../../shared/src/grpc.js";
import { conversationKey, workerScope, type TelegramMessageIdentity } from "../../shared/src/scope.js";
import { getModelSettings, unary, type ConnectWorker } from "./worker-client.js";
import type { TelegramLoginCoordinator } from "./telegram-login-coordinator.js";
import {
  messageText,
  parseCommand,
  providerDisplayName,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
} from "./telegram-base.js";
import type { TelegramUI } from "./telegram-ui.js";

interface ActiveOAuthLogin {
  userId: number;
  providerId: string;
  worker: WorkerClient;
  authChatId: number;
  statusMessageId: number;
  sessionId?: string;
  authUrl?: string;
  deviceCode?: string;
  stream?: { cancel(): void };
  awaitingInput: boolean;
  cancelled: boolean;
  release(): void;
}

type ProviderAction =
  | { type: "show_login" | "show_logout" }
  | { type: "confirm_logout" | "execute_logout" | "start_oauth_login"; providerId: string }
  | { type: "answer_oauth_prompt"; sessionId: string; input: string }
  | { type: "cancel_oauth_login"; sessionId: string };

export class TelegramProviderAuth {
  private readonly oauthLoginsByUser = new Map<number, ActiveOAuthLogin>();
  private readonly oauthLoginsBySession = new Map<string, ActiveOAuthLogin>();

  constructor(
    private readonly gateway: TelegramUI,
    private readonly connectWorker: ConnectWorker,
    private readonly logins: TelegramLoginCoordinator,
  ) {}

  async stop(): Promise<void> {
    await Promise.all([...this.oauthLoginsByUser.values()].map((login) => this.cancelOAuthLogin(login)));
  }

  private button(text: string, action: ProviderAction) {
    return this.gateway.pickerButton(text, async (identity, messageId) => {
      if (action.type === "answer_oauth_prompt" || action.type === "cancel_oauth_login") {
        const login = this.oauthLoginsBySession.get(action.sessionId);
        if (!login || login.userId !== identity.senderId || login.authChatId !== identity.chatId) return;
        if (action.type === "cancel_oauth_login") {
          await this.cancelOAuthLogin(login);
        } else {
          login.awaitingInput = false;
          const response = await unary(login.worker, "respondOAuthLogin", {
            sessionId: action.sessionId, input: action.input,
          });
          await this.updateOAuthStatus(login, response.accepted ? "Selection received. Waiting for the provider…" : response.message,
            response.accepted ? this.oauthCancelMarkup(login) : undefined);
        }
        return;
      }
      const worker = await this.connectWorker(workerScope(identity));
      switch (action.type) {
        case "show_login": await this.showLoginPicker(identity, worker); return;
        case "show_logout": await this.showLogoutPicker(identity, worker, messageId); return;
        case "confirm_logout": await this.showLogoutConfirmation(identity, worker, action.providerId, messageId); return;
        case "start_oauth_login": await this.beginOAuthLogin(identity, worker, action.providerId); return;
        case "execute_logout": {
          const response = await unary(worker, "controlConversation", {
            conversationKey: conversationKey(identity), action: "logout", instructions: action.providerId,
          });
          const name = providerDisplayName(action.providerId);
          await this.gateway.sendOrEditPicker(identity, messageId,
            response.accepted ? `Signed Out Of ${name}.\n\nUse /login_provider to connect it again.` : `Could Not Sign Out Of ${name}.\n\n${response.message}`,
            { inline_keyboard: [[this.button("Back To Accounts", { type: "show_logout" }), this.button("Connect An Account", { type: "show_login" })]] });
        }
      }
    });
  }

  async handleOAuthReply(ctx: Context, identity: TelegramMessageIdentity): Promise<boolean> {
    if (identity.chatType !== "private") return false;
    const login = this.oauthLoginsByUser.get(identity.senderId);
    if (!login || identity.chatId !== login.authChatId) return false;

    const text = messageText(ctx).trim();
    const command = parseCommand(text, this.gateway.bot.botInfo.username);
    if (command?.name === "cancel_login") {
      await this.cancelOAuthLogin(login);
      return true;
    }
    if (!login.awaitingInput) return false;
    if (command) {
      await this.gateway.reply(
        ctx,
        identity,
        "A login is waiting for its requested response. Paste that response here, or use /cancel_login.",
      );
      return true;
    }
    if (!text) {
      await this.gateway.reply(ctx, identity, "Please send the requested login response as text, or use /cancel_login.");
      return true;
    }
    if (!login.sessionId) {
      await this.gateway.reply(ctx, identity, "The login is still starting. Please try again in a moment.");
      return true;
    }

    login.awaitingInput = false;
    try {
      const response = await unary(
        login.worker,
        "respondOAuthLogin",
        { sessionId: login.sessionId, input: text },
      );
      await ctx.api.deleteMessage(identity.chatId, ctx.message!.message_id).catch(() => false);
      await this.updateOAuthStatus(
        login,
        response.accepted
          ? "Response Received. Waiting for the provider."
      : "This login is no longer waiting for input. Use /login_provider to try again.",
        response.accepted ? this.oauthCancelMarkup(login) : undefined,
      );
    } catch {
      login.awaitingInput = true;
      await this.gateway.reply(ctx, identity, "Could not submit the login response. Please try again or use /cancel_login.");
    }
    return true;
  }

  async showLoginPicker(identity: TelegramMessageIdentity, worker: WorkerClient): Promise<void> {
    const settings = await getModelSettings(worker, conversationKey(identity));
    const authenticated = new Set(settings.authenticatedProviders);
    const providers = [
      { id: "openai", name: "OpenAI" },
      { id: "openai-codex", name: "OpenAI Codex" },
      { id: "xai", name: "xAI (Grok/X)" },
    ];
    const rows = providers.map((provider) => [
      this.button(
        `${authenticated.has(provider.id) ? "✓ Reconnect" : "Connect"} ${provider.name}`,
        { type: "start_oauth_login", providerId: provider.id },
      ),
    ]);
    await this.gateway.sendOrEditPicker(
      identity,
      undefined,
      [
        "Connect An Account",
        "",
        "OAuth Sign In",
        "API keys are not supported.",
        "This account will be used in your private chats.",
        "",
        `Connected Accounts: ${providers
          .filter((provider) => authenticated.has(provider.id))
          .map((provider) => provider.name)
          .join(", ") || "None"}`,
      ].join("\n"),
      { inline_keyboard: rows },
    );
  }

  async showLogoutPicker(
    identity: TelegramMessageIdentity,
    worker: WorkerClient,
    messageId?: number,
  ): Promise<void> {
    const settings = await getModelSettings(worker, conversationKey(identity));
    const providers = [...new Set(settings.authenticatedProviders)];
    const rows = providers.map((providerId) => [
      this.button(`Log Out ${providerDisplayName(providerId)}`, {
        type: "confirm_logout",
        providerId,
      }),
    ]);
    if (providers.length === 0) {
      rows.push([this.button("Connect An Account", { type: "show_login" })]);
    }
    await this.gateway.sendOrEditPicker(
      identity,
      messageId,
      [
        "Log Out",
        "",
        providers.length > 0
          ? "Choose The Provider Account To Disconnect."
          : "No Provider Accounts Are Connected.",
      ].join("\n"),
      { inline_keyboard: rows },
    );
  }

  async showLogoutConfirmation(
    identity: TelegramMessageIdentity,
    worker: WorkerClient,
    providerId: string,
    messageId: number,
  ): Promise<void> {
    const settings = await getModelSettings(worker, conversationKey(identity));
    if (!settings.authenticatedProviders.includes(providerId)) {
      await this.gateway.sendOrEditPicker(
        identity,
        messageId,
        "That Provider Account Is No Longer Connected.",
        { inline_keyboard: [[this.button("Back To Accounts", { type: "show_logout" })]] },
      );
      return;
    }
    await this.gateway.sendOrEditPicker(
      identity,
      messageId,
      [
        `Log Out ${providerDisplayName(providerId)}?`,
        "",
        "This removes the saved OAuth credentials from this Tandoor worker. It does not revoke the provider token.",
      "Requests to this provider will stop working until you connect the account again with /login_provider.",
      ].join("\n"),
      {
        inline_keyboard: [
          [
            this.button("Confirm Log Out", { type: "execute_logout", providerId }),
            this.button("Cancel", { type: "show_logout" }),
          ],
        ],
      },
    );
  }

  async beginOAuthLogin(
    identity: TelegramMessageIdentity,
    worker: WorkerClient,
    providerId: string,
  ): Promise<void> {
    const release = this.logins.claim(identity.senderId);
    if (!release) {
      await this.gateway.bot.api.sendMessage(
        identity.chatId,
        "You already have an OAuth login in progress. Finish it or use /cancel_login first.",
        identity.threadId === undefined ? {} : { message_thread_id: identity.threadId },
      );
      return;
    }

    const authChatId = identity.chatId;
    const providerName =
      providerId === "openai-codex" ? "OpenAI Codex" : providerId === "xai" ? "xAI (Grok/X)" : "OpenAI";
    let statusMessage;
    try {
      statusMessage = await this.gateway.bot.api.sendMessage(
        authChatId,
        `Starting ${providerName} Sign In. Keep the link and any code private.`,
      );
    } catch {
      release();
      await this.gateway.bot.api.sendMessage(
        identity.chatId,
      "I cannot message you privately yet. Open this bot's private chat and send /start. Then try /login_provider again.",
        identity.threadId === undefined ? {} : { message_thread_id: identity.threadId },
      );
      return;
    }

    const login: ActiveOAuthLogin = {
      userId: identity.senderId,
      providerId,
      worker,
      authChatId,
      statusMessageId: statusMessage.message_id,
      awaitingInput: false,
      cancelled: false,
      release,
    };
    this.oauthLoginsByUser.set(identity.senderId, login);

    void this.consumeOAuthLogin(login);
  }

  private async consumeOAuthLogin(login: ActiveOAuthLogin): Promise<void> {
    try {
      const stream = login.worker.startOAuthLogin(
        { providerId: login.providerId },
        workerMetadata(login.worker),
      );
      login.stream = stream;
      for await (const wire of stream as AsyncIterable<WireOAuthLoginEvent>) {
        if (!wire.sessionId || (login.sessionId && login.sessionId !== wire.sessionId)) {
          throw new Error("The worker returned an unexpected login session.");
        }
        if (!login.sessionId) {
          login.sessionId = wire.sessionId;
          this.oauthLoginsBySession.set(wire.sessionId, login);
        }
        const event = decodeEvent(wire);
        if (event.type === "authUrl") {
          login.authUrl = event.data.url;
          await this.updateOAuthStatus(
            login,
            [
              "Use the link below to complete sign in:",
              "",
              event.data.url,
              "",
              "After you approve access, your browser may show an error or fail to load. If that happens, copy the full URL from the address bar and send it here.",
            ].join("\n"),
            {
              inline_keyboard: [
                [{ text: "Open Sign In Page", url: event.data.url }],
                ...(this.oauthCancelMarkup(login)?.inline_keyboard ?? []),
              ],
            },
          );
        } else if (event.type === "deviceCode") {
          login.authUrl = event.data.verificationUri;
          login.deviceCode = event.data.userCode;
          const minutes = Math.max(1, Math.ceil(event.data.expiresInSeconds / 60));
          await this.updateOAuthStatus(
            login,
            [
              "Open The Verification Page:",
              event.data.verificationUri,
              "",
              "Enter This One Time Code:",
              event.data.userCode,
              "",
              `The code expires in about ${minutes} minutes. If the link does not open automatically, copy the URL into your browser.`,
            ].join("\n"),
            {
              inline_keyboard: [
                [{ text: "Open Verification Page", url: event.data.verificationUri }],
                ...(this.oauthCancelMarkup(login)?.inline_keyboard ?? []),
              ],
            },
          );
        } else if (event.type === "info") {
          const links = event.data.links.slice(0, 3).map((url, index) => [
            { text: `Open Link ${index + 1}`, url },
          ]);
          await this.updateOAuthStatus(
            login,
            event.data.message,
            { inline_keyboard: [...links, ...(this.oauthCancelMarkup(login)?.inline_keyboard ?? [])] },
          );
        } else if (event.type === "progress") {
          await this.updateOAuthStatus(login, event.data.message, this.oauthCancelMarkup(login));
        } else if (event.type === "prompt") {
          if (event.data.promptType === "select" && event.data.options.length > 0) {
            const rows: InlineKeyboardButton[][] = event.data.options.map((option) => [
              this.button(option.label, {
                type: "answer_oauth_prompt",
                sessionId: wire.sessionId,
                input: option.id,
              }),
            ]);
            rows.push(...(this.oauthCancelMarkup(login)?.inline_keyboard ?? []));
            await this.updateOAuthStatus(login, event.data.message, { inline_keyboard: rows });
          } else {
            login.awaitingInput = true;
            const promptText =
              event.data.promptType === "manual_code"
                ? [
                    "Use the link below to complete sign in:",
                    "",
                    ...(login.authUrl ? [login.authUrl] : []),
                    "",
                    "After you approve access, your browser may show an error or fail to load. If that happens, copy the full URL from the address bar and send it here.",
                  ].join("\n")
                : `${event.data.message}\n\n${event.data.placeholder || "Reply with the requested value."}`;
            await this.updateOAuthStatus(login, promptText, this.oauthCancelMarkup(login));
          }
        } else if (event.type === "completed") {
          login.awaitingInput = false;
          await this.updateOAuthStatus(login, "Sign In Complete. You can now choose a model with /model.");
        } else if (event.type === "failed") {
          login.awaitingInput = false;
          await this.updateOAuthStatus(
            login,
      login.cancelled ? "Sign In Cancelled." : "Sign In Failed. Use /login_provider to try again.",
          );
        }
      }
    } catch {
      await this.updateOAuthStatus(
        login,
      login.cancelled ? "Sign In Cancelled." : "Sign In Failed. Use /login_provider to try again.",
      );
    } finally {
      this.oauthLoginsByUser.delete(login.userId);
      if (login.sessionId) this.oauthLoginsBySession.delete(login.sessionId);
      login.release();
    }
  }

  oauthCancelMarkup(login: ActiveOAuthLogin): InlineKeyboardMarkup | undefined {
    return login.sessionId
      ? {
          inline_keyboard: [[
            this.button("Cancel Login", {
              type: "cancel_oauth_login",
              sessionId: login.sessionId,
            }),
          ]],
        }
      : undefined;
  }

  async updateOAuthStatus(
    login: ActiveOAuthLogin,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void> {
    const isTerminal =
      text.startsWith("Sign In Complete.") ||
      text.startsWith("Sign In Cancelled.") ||
      text.startsWith("Sign In Failed.");
    let visibleText = text;
    if (!isTerminal && login.authUrl && !visibleText.includes(login.authUrl)) {
      visibleText += `\n\nSign In Link:\n${login.authUrl}`;
    }
    if (!isTerminal && login.deviceCode && !visibleText.includes(login.deviceCode)) {
      visibleText += `\n\nOne Time Code:\n${login.deviceCode}`;
    }
    await this.gateway.bot.api
      .editMessageText(login.authChatId, login.statusMessageId, visibleText, {
        ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
      })
      .catch(() => undefined);
  }

  async cancelOAuthLogin(login: ActiveOAuthLogin): Promise<void> {
    login.cancelled = true;
    login.awaitingInput = false;
    if (login.sessionId) {
      await unary(
        login.worker,
        "cancelOAuthLogin",
        { sessionId: login.sessionId },
      ).catch(() => undefined);
    } else {
      login.stream?.cancel();
    }
    await this.updateOAuthStatus(login, "Login Cancellation Requested.");
  }
}
