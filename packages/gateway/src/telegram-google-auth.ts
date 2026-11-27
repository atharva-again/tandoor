import { randomUUID } from "node:crypto";
import type { Context } from "grammy";
import type {
  GoogleLoginCancelResponse,
  GoogleLoginStartResponse,
  WorkerClient,
} from "../../shared/src/grpc.js";
import type { TandoorConfig } from "../../shared/src/config.js";
import type { TelegramMessageIdentity } from "../../shared/src/scope.js";
import {
  GoogleOAuthCallbackServer,
  type GoogleOAuthSession,
  type GoogleLoginCompletionResult,
  type GoogleLoginExpiryResult,
} from "./google-oauth-callback-server.js";
import {
  googleAccountButtonLabel,
  isGoogleAccountEmail,
  isGoogleCallbackUrl,
  messageText,
  parseCommand,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
} from "./telegram-base.js";
import type { TelegramUI } from "./telegram-ui.js";
import { unary, type ConnectWorker } from "./worker-client.js";
import type { TelegramLoginCoordinator } from "./telegram-login-coordinator.js";

interface ActiveGoogleLogin extends GoogleOAuthSession {
  flowId: string;
  userId: number;
  worker: WorkerClient;
  authChatId: number;
  statusMessageId?: number;
  release(): void;
}

type GoogleAction =
  | { type: "show_google_logout_accounts" }
  | { type: "select_google_logout_account" | "execute_google_logout"; email: string }
  | { type: "cancel_google_login"; flowId: string };

const GOOGLE_OAUTH_OPEN_PATH = "/oauth/google/open";

export class TelegramGoogleAuth {
  private readonly googleOAuthCallback: GoogleOAuthCallbackServer<ActiveGoogleLogin>;
  private readonly googleLoginsByUser = new Map<number, ActiveGoogleLogin>();
  private readonly googleLoginsByState = new Map<string, ActiveGoogleLogin>();

  constructor(
    private readonly gateway: TelegramUI,
    private readonly config: Pick<TandoorConfig, "googleOAuthWebClientFile" | "googleOAuthRedirectUri" | "googleOAuthCallbackPort">,
    private readonly connectWorker: ConnectWorker,
    private readonly logins: TelegramLoginCoordinator,
  ) {
    this.googleOAuthCallback = new GoogleOAuthCallbackServer({
      config,
      getLoginByState: (state) => this.googleLoginsByState.get(state),
      completeLogin: (login, authUrl) => this.completeGoogleLogin(login, authUrl),
      expireLogin: (login) => this.expireGoogleLogin(login),
    });
  }

  private button(text: string, action: GoogleAction) {
    return this.gateway.pickerButton(text, async (identity, messageId) => {
      switch (action.type) {
        case "show_google_logout_accounts": await this.showGoogleLogoutAccounts(identity, messageId); return;
        case "select_google_logout_account": await this.showGoogleLogoutConfirmation(identity, action.email, messageId); return;
        case "execute_google_logout": await this.executeGoogleLogout(identity, action.email, messageId); return;
        case "cancel_google_login": {
          const login = this.googleLoginsByUser.get(identity.senderId);
          if (
            login?.flowId === action.flowId &&
            login.authChatId === identity.chatId
          ) {
            await this.cancelGoogleLogin(login);
          }
        }
      }
    });
  }

  startGoogleOAuthCallbackServer(): Promise<void> {
    return this.googleOAuthCallback.start();
  }

  stopGoogleOAuthCallbackServer(): Promise<void> {
    return this.googleOAuthCallback.stop();
  }

  async stop(): Promise<void> {
    await this.stopGoogleOAuthCallbackServer();
    await Promise.all([...this.googleLoginsByUser.values()].map((login) => this.cancelGoogleLogin(login)));
  }

  private async completeGoogleLogin(
    login: ActiveGoogleLogin,
    authUrl: string,
  ): Promise<GoogleLoginCompletionResult> {
    if (login.state.status !== "awaiting_callback") return "failed";
    const callbackState = login.state;
    login.state = { ...callbackState, status: "completing" };
    await this.updateGoogleLoginStatus(login, "Checking Google Sign In…");
    try {
      const result = await unary(
        login.worker,
        "completeGoogleLogin",
        { sessionId: callbackState.sessionId, authUrl },
      );
      if (this.googleLoginsByUser.get(login.userId) !== login) return "failed";
      if (!result.accepted) {
        login.state = {
          status: "awaiting_callback",
          sessionId: callbackState.sessionId,
          email: callbackState.email,
          authUrl: callbackState.authUrl,
          oauthState: callbackState.oauthState,
          expiresAt: callbackState.expiresAt,
        };
        const friendlyError = /no refresh token received/i.test(result.error)
          ? "Google didn't finish connecting your account. Please try again and approve the access Google asks you about."
          : "Tandoor couldn't finish connecting your Google account. Please try again.";
        await this.updateGoogleLoginStatus(
          login,
          [
            "Google Sign In Could Not Be Completed.",
            "",
            friendlyError,
            "",
            "To start over, use /cancel_login and then /login_google.",
          ].join("\n"),
          this.googleCancelMarkup(login),
        );
        return "failed";
      }
      this.removeGoogleLogin(login);
      await this.updateGoogleLoginStatus(
        login,
        [
          "Google Account Connected",
          "",
          `Account: ${callbackState.email}`,
          "",
          "You can connect another account by running /login_google again.",
        ].join("\n"),
      );
      return "success";
    } catch {
      if (this.googleLoginsByUser.get(login.userId) === login) {
        login.state = { ...callbackState, retryAuthUrl: authUrl };
        await this.updateGoogleLoginStatus(
          login,
          [
            "Tandoor Could Not Confirm The Google Sign In Result.",
            "",
            "Google may still be finishing the connection. Open the same sign-in link again to check the result before starting over.",
          ].join("\n"),
          this.googleCancelMarkup(login),
        );
      }
      return "processing";
    }
  }

  private removeGoogleLogin(login: ActiveGoogleLogin): void {
    if (this.googleLoginsByUser.get(login.userId) === login) {
      this.googleLoginsByUser.delete(login.userId);
      login.release();
    }
    if (
      "sessionId" in login.state &&
      this.googleLoginsByState.get(login.state.oauthState) === login
    ) {
      this.googleLoginsByState.delete(login.state.oauthState);
    }
  }

  private async expireGoogleLogin(login: ActiveGoogleLogin): Promise<GoogleLoginExpiryResult> {
    const state = login.state;
    if (state.status === "completing") {
      await this.updateGoogleLoginStatus(login, "Google Sign In Is Finishing. Check Telegram for the final result.");
      return "processing";
    }
    if (state.status === "awaiting_callback") {
      let result: GoogleLoginCancelResponse;
      try {
        result = await unary(
          login.worker,
          "cancelGoogleLogin",
          { sessionId: state.sessionId },
        );
      } catch {
        await this.updateGoogleLoginStatus(
          login,
          "Google Sign In Expired, but Tandoor could not confirm its final state. Check Telegram before starting again.",
        );
        return "processing";
      }
      if (result.status === "completing") {
        await this.updateGoogleLoginStatus(login, "Google Sign In Is Finishing. Check Telegram for the final result.");
        return "processing";
      }
      if (result.status === "completed") {
        this.removeGoogleLogin(login);
        await this.updateGoogleLoginStatus(
          login,
          `Google Account Connected\n\nAccount: ${state.email}`,
        );
        return "success";
      }
    }
    this.removeGoogleLogin(login);
    await this.updateGoogleLoginStatus(login, "Google Sign In Expired. Run /login_google to start again.");
    return "failed";
  }

  private async runGoogleAuthCommand(
    worker: WorkerClient,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    const response = await unary(
      worker,
      "executeIntegration",
      {
        integrationId: "gog",
        operation: "command",
        payloadJson: JSON.stringify({ args }),
      },
    );
    if (!response.accepted) throw new Error(response.error || "Google account operation failed.");
    let result: unknown;
    try {
      result = JSON.parse(response.payloadJson);
    } catch {
      throw new Error("Google returned an invalid account response.");
    }
    if (
      typeof result !== "object" ||
      result === null ||
      !("exitCode" in result) ||
      typeof result.exitCode !== "number" ||
      !("stdout" in result) ||
      typeof result.stdout !== "string" ||
      !("stderr" in result) ||
      typeof result.stderr !== "string"
    ) {
      throw new Error("Google returned an invalid account response.");
    }
    if (result.exitCode !== 0) throw new Error(result.stderr || "Google account operation failed.");
    return { stdout: result.stdout, stderr: result.stderr };
  }

  private async listGoogleAccounts(worker: WorkerClient): Promise<string[]> {
    const result = await this.runGoogleAuthCommand(worker, ["--client", "tandoor-web", "auth", "list"]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("Google returned an invalid account list.");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("accounts" in parsed) ||
      !Array.isArray(parsed.accounts)
    ) {
      throw new Error("Google returned an invalid account list.");
    }
    const emails = parsed.accounts.flatMap((account) => {
      if (typeof account !== "object" || account === null || !("email" in account)) return [];
      const client = "client" in account && typeof account.client === "string" ? account.client : "";
      const auth = "auth" in account && typeof account.auth === "string" ? account.auth : "";
      if ((client && client !== "tandoor-web") || (auth && auth !== "oauth") || !isGoogleAccountEmail(account.email)) {
        return [];
      }
      return [account.email];
    });
    return [...new Map(emails.map((email) => [email.toLowerCase(), email])).values()];
  }

  async showGoogleLogoutAccounts(
    identity: TelegramMessageIdentity,
    messageId?: number,
  ): Promise<void> {
    let accounts: string[];
    try {
      const worker = await this.connectWorker({ kind: "user", id: String(identity.senderId) });
      accounts = await this.listGoogleAccounts(worker);
    } catch {
      await this.gateway.sendOrEditPicker(
        identity,
        messageId,
        "I couldn't check the connected Google accounts. Please try again.",
        {
          inline_keyboard: [
            [this.button("Try Again", { type: "show_google_logout_accounts" })],
          ],
        },
      );
      return;
    }

    if (accounts.length === 0) {
      await this.gateway.sendOrEditPicker(
        identity,
        messageId,
        "No Google accounts are connected.\n\nUse /login_google to connect one.",
        { inline_keyboard: [] },
      );
      return;
    }

    const rows = accounts.map((email) => [
      this.button(googleAccountButtonLabel(email), {
        type: "select_google_logout_account",
        email,
      }),
    ]);
    rows.push([this.button("Refresh", { type: "show_google_logout_accounts" })]);
    await this.gateway.sendOrEditPicker(
      identity,
      messageId,
      "Choose the Google account to disconnect.",
      { inline_keyboard: rows },
    );
  }

  async showGoogleLogoutConfirmation(
    identity: TelegramMessageIdentity,
    email: string,
    messageId: number,
  ): Promise<void> {
    if (!isGoogleAccountEmail(email)) return;
    let accounts: string[];
    try {
      const worker = await this.connectWorker({ kind: "user", id: String(identity.senderId) });
      accounts = await this.listGoogleAccounts(worker);
    } catch {
      await this.gateway.sendOrEditPicker(
        identity,
        messageId,
        "I couldn't check that Google account. Please try again.",
        { inline_keyboard: [[this.button("Back To Accounts", { type: "show_google_logout_accounts" })]] },
      );
      return;
    }
    const connectedEmail = accounts.find((account) => account.toLowerCase() === email.toLowerCase());
    if (!connectedEmail) {
      await this.gateway.sendOrEditPicker(
        identity,
        messageId,
        "That Google account is no longer connected.",
        { inline_keyboard: [[this.button("Back To Accounts", { type: "show_google_logout_accounts" })]] },
      );
      return;
    }
    await this.gateway.sendOrEditPicker(
      identity,
      messageId,
      [
        `Disconnect ${connectedEmail}?`,
        "",
        "Tandoor will forget this saved sign-in and stop using the account in your private chats.",
        "To remove Tandoor's permission in Google too, remove it from your Google Account's third-party connections.",
      ].join("\n"),
      {
        inline_keyboard: [[
          this.button("Disconnect Account", { type: "execute_google_logout", email: connectedEmail }),
          this.button("Cancel", { type: "show_google_logout_accounts" }),
        ]],
      },
    );
  }

  async executeGoogleLogout(
    identity: TelegramMessageIdentity,
    email: string,
    messageId: number,
  ): Promise<void> {
    if (!isGoogleAccountEmail(email)) return;
    let worker: WorkerClient;
    let accounts: string[];
    try {
      worker = await this.connectWorker({ kind: "user", id: String(identity.senderId) });
      accounts = await this.listGoogleAccounts(worker);
    } catch {
      await this.gateway.sendOrEditPicker(
        identity,
        messageId,
        "I couldn't check that Google account. Please try again.",
        { inline_keyboard: [[this.button("Back To Accounts", { type: "show_google_logout_accounts" })]] },
      );
      return;
    }
    const connectedEmail = accounts.find((account) => account.toLowerCase() === email.toLowerCase());
    if (!connectedEmail) {
      await this.gateway.sendOrEditPicker(
        identity,
        messageId,
        "That Google account is no longer connected.",
        { inline_keyboard: [[this.button("Back To Accounts", { type: "show_google_logout_accounts" })]] },
      );
      return;
    }
    try {
      await this.runGoogleAuthCommand(worker, ["-y", "--client", "tandoor-web", "auth", "remove", connectedEmail]);
    } catch {
      await this.gateway.sendOrEditPicker(
        identity,
        messageId,
        "I couldn't disconnect that Google account. Please try again.",
        { inline_keyboard: [[this.button("Back To Accounts", { type: "show_google_logout_accounts" })]] },
      );
      return;
    }
    await this.gateway.sendOrEditPicker(
      identity,
      messageId,
      `Disconnected ${connectedEmail} from Tandoor.\n\nTo connect it again, use /login_google.`,
      { inline_keyboard: [] },
    );
  }

  async beginGoogleLoginPrompt(
    identity: TelegramMessageIdentity,
    worker: WorkerClient,
  ): Promise<boolean> {
    const release = this.logins.claim(identity.senderId);
    if (!release) {
      await this.gateway.bot.api.sendMessage(
        identity.chatId,
        "You already have a login in progress. Finish it or use /cancel_login first.",
      );
      return false;
    }

    const authChatId = identity.chatId;
    const flowId = randomUUID().slice(0, 16);
    let statusMessage: { message_id: number };
    try {
      statusMessage = await this.gateway.bot.api.sendMessage(
        authChatId,
        [
          "Google Sign In",
          "",
          "Send the Google account email address you want to connect.",
          "",
          "You can connect more accounts later by running /login_google again.",
          "",
          "This account will be used in your private chats.",
        ].join("\n"),
        {
          reply_markup: { inline_keyboard: [[this.button("Cancel Login", { type: "cancel_google_login", flowId })]] },
        },
      );
    } catch {
      release();
      await this.gateway.bot.api.sendMessage(
        identity.chatId,
        "I cannot message you privately yet. Open this bot's private chat and send /start, then try /login_google again.",
      );
      return false;
    }

    this.googleLoginsByUser.set(identity.senderId, {
      flowId,
      userId: identity.senderId,
      worker,
      authChatId,
      statusMessageId: statusMessage.message_id,
      state: { status: "awaiting_email" },
      release,
    });
    return true;
  }

  async handleGoogleLoginReply(ctx: Context, identity: TelegramMessageIdentity): Promise<boolean> {
    if (identity.chatType !== "private") return false;
    const login = this.googleLoginsByUser.get(identity.senderId);
    if (!login || identity.chatId !== login.authChatId) return false;

    const text = messageText(ctx).trim();
    const command = parseCommand(text, this.gateway.bot.botInfo.username);
    if (command?.name === "cancel_login") {
      await this.cancelGoogleLogin(login);
      return true;
    }
    if (command) {
      await this.gateway.reply(
        ctx,
        identity,
        "Google sign in is waiting for your account email or the full callback URL. Use /cancel_login to stop.",
      );
      return true;
    }
    if (!text) {
      await this.gateway.reply(ctx, identity, "Please send the requested Google sign in information, or use /cancel_login.");
      return true;
    }

    if (login.state.status === "starting" || login.state.status === "completing") {
      await this.gateway.reply(ctx, identity, "Google is processing your request. Please wait a moment.");
      return true;
    }

    if (login.state.status === "awaiting_email") {
      login.state = { status: "starting" };
      delete login.statusMessageId;
      let response: GoogleLoginStartResponse;
      try {
        response = await unary(login.worker, "startGoogleLogin", { email: text });
      } catch {
        if (this.googleLoginsByUser.get(login.userId) !== login) return true;
        login.state = { status: "awaiting_email" };
        await this.sendGoogleLoginStatus(
          login,
          "Could Not Start Google Sign In.\n\nSend the Google account email address again, or use /cancel_login.",
          this.googleCancelMarkup(login),
        );
        return true;
      }
      if (this.googleLoginsByUser.get(login.userId) !== login) {
        if (response.sessionId) {
          await unary(
            login.worker,
            "cancelGoogleLogin",
            { sessionId: response.sessionId },
          ).catch(() => undefined);
        }
        return true;
      }
      if (!response.accepted || !response.sessionId || !response.authUrl) {
        login.state = { status: "awaiting_email" };
        await this.sendGoogleLoginStatus(
          login,
          `${response.error || "Could not start Google sign in."}\n\nSend the Google account email address again, or use /cancel_login.`,
          this.googleCancelMarkup(login),
        );
        return true;
      }

      let oauthState: string | null;
      try {
        const authUrl = new URL(response.authUrl);
        oauthState =
          authUrl.protocol === "https:" && authUrl.hostname === "accounts.google.com"
            ? authUrl.searchParams.get("state")
            : null;
      } catch {
        oauthState = null;
      }
      if (!oauthState || oauthState.length > 1_024 || this.googleLoginsByState.has(oauthState)) {
        await unary(
          login.worker,
          "cancelGoogleLogin",
          { sessionId: response.sessionId },
        ).catch(() => undefined);
        login.state = { status: "awaiting_email" };
        await this.sendGoogleLoginStatus(
          login,
          "Google returned an invalid sign-in link. Send the account email again to retry.",
          this.googleCancelMarkup(login),
        );
        return true;
      }

      login.state = {
        status: "awaiting_callback",
        sessionId: response.sessionId,
        email: response.email,
        authUrl: response.authUrl,
        oauthState,
        expiresAt: Date.now() + 9 * 60_000,
      };
      this.googleLoginsByState.set(oauthState, login);
      const browserAuthLink = new URL(GOOGLE_OAUTH_OPEN_PATH, this.config.googleOAuthRedirectUri);
      browserAuthLink.searchParams.set("state", oauthState);
      const copyLink = browserAuthLink.toString();
      const copyLinkAvailable = copyLink.length <= 256;
      const handoffButtons: InlineKeyboardButton[][] = [
        [{ text: "Open Google Sign In", url: copyLink }],
        ...(copyLinkAvailable ? [[{ text: "Copy Link", copy_text: { text: copyLink } }]] : []),
        ...this.googleCancelMarkup(login).inline_keyboard,
      ];
      await this.sendGoogleLoginStatus(
        login,
        [
          `Connect ${response.email} To Tandoor`,
          "",
          "Tap Open Google Sign In below to continue.",
          "",
          ...(copyLinkAvailable
            ? ["If Google isn't signed in there, tap Copy Link and paste it into your browser."]
            : []),
          "",
          "Please finish sign-in within 10 minutes.",
          "",
          "After you approve access, Google should return you to Tandoor automatically.",
          "",
          "If the return page has a problem, copy its address and send it here. Tandoor will delete that message after using it.",
        ].join("\n"),
        { inline_keyboard: handoffButtons },
      );
      return true;
    }

    const callbackState = login.state;
    if (callbackState.status !== "awaiting_callback") {
      await this.gateway.reply(ctx, identity, "Google sign in is still starting. Please try again in a moment.");
      return true;
    }
    if (!isGoogleCallbackUrl(text)) {
      await this.gateway.reply(
        ctx,
        identity,
        "That does not look like the full Google callback URL. Copy the complete URL from your browser's address bar and send it here.",
      );
      return true;
    }
    await this.completeGoogleLogin(login, text);
    await ctx.api.deleteMessage(identity.chatId, ctx.message!.message_id).catch(() => false);
    return true;
  }

  private googleCancelMarkup(login: ActiveGoogleLogin): InlineKeyboardMarkup {
    return {
      inline_keyboard: [[this.button("Cancel Login", { type: "cancel_google_login", flowId: login.flowId })]],
    };
  }

  private async updateGoogleLoginStatus(
    login: ActiveGoogleLogin,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void> {
    if (login.statusMessageId === undefined) {
      await this.sendGoogleLoginStatus(login, text, replyMarkup);
      return;
    }
    await this.gateway.bot.api.editMessageText(login.authChatId, login.statusMessageId, text, {
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    }).catch(() => undefined);
  }

  private async sendGoogleLoginStatus(
    login: ActiveGoogleLogin,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void> {
    try {
      const message = await this.gateway.bot.api.sendMessage(login.authChatId, text, {
        reply_markup: replyMarkup ?? { inline_keyboard: [] },
      });
      login.statusMessageId = message.message_id;
    } catch {
      // Keep the login active so the user can retry or cancel.
    }
  }

  async cancelGoogleLogin(login: ActiveGoogleLogin): Promise<void> {
    const state = login.state;
    if (state.status === "completing") {
      await this.updateGoogleLoginStatus(
        login,
        "Google Sign In Is Finishing.\n\nCancellation is no longer available. Tandoor will report whether the account connected.",
      );
      return;
    }
    if (state.status === "awaiting_callback") {
      let result: GoogleLoginCancelResponse;
      try {
        result = await unary(
          login.worker,
          "cancelGoogleLogin",
          { sessionId: state.sessionId },
        );
      } catch {
        await this.updateGoogleLoginStatus(
          login,
          "Tandoor could not confirm cancellation. The sign-in may still be active; check Telegram or try /cancel_login again.",
          this.googleCancelMarkup(login),
        );
        return;
      }
      if (result.status === "completing") {
        await this.updateGoogleLoginStatus(
          login,
          "Google Sign In Is Finishing.\n\nCancellation is no longer available. Tandoor will report whether the account connected.",
        );
        return;
      }
      if (result.status === "completed") {
        this.removeGoogleLogin(login);
        await this.updateGoogleLoginStatus(
          login,
          `Google Account Connected\n\nAccount: ${state.email}`,
        );
        return;
      }
      if (result.status === "inactive") {
        this.removeGoogleLogin(login);
        await this.updateGoogleLoginStatus(login, "Google Sign In Expired. Run /login_google to start again.");
        return;
      }
    }
    this.removeGoogleLogin(login);
    await this.updateGoogleLoginStatus(login, "Google Sign In Cancelled.");
  }
}
