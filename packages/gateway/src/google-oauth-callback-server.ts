import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { TandoorConfig } from "../../shared/src/config.js";
import {
  GOOGLE_OAUTH_CALLBACK_PATH,
  GOOGLE_OAUTH_COMPLETE_PATH,
} from "../../shared/src/config.js";

const GOOGLE_OAUTH_OPEN_PATH = "/oauth/google/open";
const GOOGLE_OAUTH_LOGO_PATH = "/assets/tandoor-logo.png";
const GOOGLE_OAUTH_SAD_LOGO_PATH = "/assets/tandoor-logo-sad.png";
const GOOGLE_OAUTH_LOGO_ASSET = new URL("../../brand/assets/tandoor-logo.png", import.meta.url);
const GOOGLE_OAUTH_SAD_LOGO_ASSET = new URL(
  "../../brand/assets/01a1f4db-dae8-72e2-8a49-54707f2fa6c3/ig_092fda96fc6e6f9b016b03016e48e487d08452045e1a07dfb4.png",
  import.meta.url,
);

export type GoogleLoginSessionState = {
  sessionId: string;
  email: string;
  authUrl: string;
  retryAuthUrl?: string;
  oauthState: string;
  expiresAt: number;
} & (
  | { status: "awaiting_callback" }
  | { status: "completing" }
);

export interface GoogleOAuthSession {
  state:
    | { status: "awaiting_email" }
    | { status: "starting" }
    | GoogleLoginSessionState;
}

export type GoogleLoginCompletionResult = "success" | "processing" | "failed";
export type GoogleLoginExpiryResult = "success" | "processing" | "failed";

export interface GoogleOAuthCallbackOptions<T extends GoogleOAuthSession> {
  config: Pick<TandoorConfig, "googleOAuthWebClientFile" | "googleOAuthRedirectUri" | "googleOAuthCallbackPort">;
  getLoginByState(state: string): T | undefined;
  completeLogin(login: T, authUrl: string): Promise<GoogleLoginCompletionResult>;
  expireLogin(login: T): Promise<GoogleLoginExpiryResult>;
}

export class GoogleOAuthCallbackServer<T extends GoogleOAuthSession> {
  private server: Server | undefined;

  constructor(private readonly options: GoogleOAuthCallbackOptions<T>) {}

  async start(): Promise<void> {
    if (!this.options.config.googleOAuthWebClientFile) return;
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch(() => {
        this.redirectResult(response, "failed");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.config.googleOAuthCallbackPort, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const redirect = new URL(this.options.config.googleOAuthRedirectUri);
    const requestTarget = request.url ?? "/";
    if (requestTarget.length > 16_384) {
      this.redirectResult(response, "failed");
      return;
    }
    let url: URL;
    try {
      url = new URL(requestTarget, redirect);
    } catch {
      this.redirectResult(response, "failed");
      return;
    }
    if (
      request.method !== "GET" ||
      url.origin !== redirect.origin ||
      request.headers.host?.toLowerCase() !== redirect.host.toLowerCase()
    ) {
      this.redirectResult(response, "failed");
      return;
    }
    if (url.pathname === GOOGLE_OAUTH_LOGO_PATH || url.pathname === GOOGLE_OAUTH_SAD_LOGO_PATH) {
      await this.sendLogo(
        response,
        url.pathname === GOOGLE_OAUTH_SAD_LOGO_PATH ? GOOGLE_OAUTH_SAD_LOGO_ASSET : GOOGLE_OAUTH_LOGO_ASSET,
      );
      return;
    }
    if (url.pathname === GOOGLE_OAUTH_COMPLETE_PATH) {
      this.sendCompletePage(response, url.searchParams.get("result"));
      return;
    }
    if (url.pathname === GOOGLE_OAUTH_OPEN_PATH) {
      const states = url.searchParams.getAll("state");
      if (states.length !== 1 || !states[0] || states[0].length > 1_024) {
        this.redirectResult(response, "failed");
        return;
      }
      const login = this.options.getLoginByState(states[0]);
      if (!login || !("sessionId" in login.state) || login.state.oauthState !== states[0]) {
        this.redirectResult(response, "failed");
        return;
      }
      if (login.state.status === "completing") {
        this.redirectResult(response, "processing");
        return;
      }
      if (Date.now() > login.state.expiresAt) {
        const result = await this.options.expireLogin(login);
        this.redirectResult(response, result);
        return;
      }
      if (login.state.status !== "awaiting_callback") {
        this.redirectResult(response, "failed");
        return;
      }
      if (login.state.retryAuthUrl) {
        const result = await this.options.completeLogin(login, login.state.retryAuthUrl);
        this.redirectResult(response, result);
        return;
      }
      response.writeHead(303, {
        Location: login.state.authUrl,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      }).end();
      return;
    }
    if (url.pathname !== GOOGLE_OAUTH_CALLBACK_PATH) {
      response.writeHead(404, { "Cache-Control": "no-store" }).end("Not found.");
      return;
    }

    const states = url.searchParams.getAll("state");
    const codes = url.searchParams.getAll("code");
    const errors = url.searchParams.getAll("error");
    if (
      states.length !== 1 ||
      !states[0] ||
      states[0].length > 1_024 ||
      codes.length + errors.length !== 1 ||
      (codes.length === 1 && !codes[0]) ||
      (errors.length === 1 && !errors[0])
    ) {
      this.redirectResult(response, "failed");
      return;
    }

    const state = states[0];
    const login = this.options.getLoginByState(state);
    if (!login || !("sessionId" in login.state) || login.state.oauthState !== state) {
      this.redirectResult(response, "failed");
      return;
    }
    if (login.state.status === "completing") {
      this.redirectResult(response, "processing");
      return;
    }
    if (Date.now() > login.state.expiresAt) {
      const result = await this.options.expireLogin(login);
      this.redirectResult(response, result);
      return;
    }
    if (login.state.status !== "awaiting_callback") {
      this.redirectResult(response, "failed");
      return;
    }

    const callbackUrl = new URL(this.options.config.googleOAuthRedirectUri);
    callbackUrl.search = url.search;
    const result = await this.options.completeLogin(login, callbackUrl.toString());
    this.redirectResult(response, result);
  }

  private redirectResult(response: ServerResponse, result: "success" | "processing" | "failed"): void {
    const location = new URL(GOOGLE_OAUTH_COMPLETE_PATH, this.options.config.googleOAuthRedirectUri);
    location.searchParams.set("result", result);
    response.writeHead(303, {
      Location: `${location.pathname}${location.search}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    }).end();
  }

  private async sendLogo(response: ServerResponse, asset: URL): Promise<void> {
    const image = await readFile(asset);
    response.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": image.byteLength,
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    }).end(image);
  }

  private sendCompletePage(response: ServerResponse, result: string | null): void {
    const state =
      result === "success"
        ? {
            title: null,
            logo: GOOGLE_OAUTH_LOGO_PATH,
            message: "Your Google account is now connected to Tandoor.",
            next: "You can safely return to Telegram.",
          }
        : result === "processing"
          ? {
              title: "Finishing sign-in",
              logo: GOOGLE_OAUTH_LOGO_PATH,
              message: "Google has returned you to Tandoor.",
              next: "Check Telegram in a moment for the final status.",
            }
          : {
              title: null,
              logo: GOOGLE_OAUTH_SAD_LOGO_PATH,
              message: "Tandoor wasn’t able to finish connecting your Google account.",
              next: "Return to Telegram and start again.",
            };
    const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${state.title ? `${state.title} · ` : ""}Tandoor</title>
    <style>
      :root {
        color-scheme: light dark;
        --page: light-dark(#fff, #050505);
        --text: light-dark(#222, #eee);
        --muted: light-dark(#666, #aaa);
        --border: light-dark(#d7d7d7, #333);
        --subtle: light-dark(#f4f4f4, #141414);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-synthesis: none;
      font-size: 16px;
      line-height: 1.65;
        text-rendering: optimizeLegibility;
        -webkit-font-smoothing: antialiased;
      }
      * { box-sizing: border-box; }
      body {
      position: relative;
        margin: 0;
        background: var(--page);
        color: var(--text);
      }
      main {
      width: min(calc(100% - 40px), 800px);
      min-height: 68vh;
      margin-inline: auto;
      padding: 42px 0 64px;
      overflow-wrap: anywhere;
    }
      h1 {
      margin: 0 0 16px;
      font-size: 2em;
        font-weight: 640;
      letter-spacing: -0.055em;
      line-height: 1.25;
      }
      .logo {
      display: block;
      width: 128px;
      height: auto;
      margin: 0 0 24px;
      }
    p { margin: 0 0 16px; }
    </style>
  </head>
  <body>
  <main>
    <img class="logo" src="${state.logo}" width="128" height="128" alt="Tandoor">
    ${state.title ? `<h1>${state.title}</h1>` : ""}
    <p>${state.message}</p>
    <p>${state.next}</p>
    </main>
  </body>
</html>`;
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    }).end(body);
  }
}
