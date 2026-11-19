import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { accessSync, constants, statSync } from "node:fs";

export const DEFAULT_GOOGLE_OAUTH_REDIRECT_URI =
  "https://auth.atharvaverma.com/oauth/google/callback";
export const GOOGLE_OAUTH_CALLBACK_PATH = "/oauth/google/callback";
export const GOOGLE_OAUTH_COMPLETE_PATH = "/oauth/google/complete";

export interface TandoorConfig {
  telegramBotToken: string;
  allowedUserIds: ReadonlySet<string>;
  dataDir: string;
  workerImage: string;
  podman: string;
  modelProvider: "openai" | "openai-codex" | "xai";
  modelId: string;
  contextDevApiKey?: string;
  /** Existing default/desktop Gog client, retained for previously connected accounts. */
  googleOAuthClientFile?: string;
  /** Web OAuth client used only for the public Google callback flow. */
  googleOAuthWebClientFile?: string;
  googleOAuthRedirectUri: string;
  googleOAuthCallbackPort: number;
}

export function validateGoogleOAuthRedirectUri(value: string): string {
  const redirectUri = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new Error("TANDOOR_GOOGLE_OAUTH_REDIRECT_URI must be a valid HTTPS URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== GOOGLE_OAUTH_CALLBACK_PATH ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `TANDOOR_GOOGLE_OAUTH_REDIRECT_URI must be an HTTPS URL ending in ${GOOGLE_OAUTH_CALLBACK_PATH}, without query or fragment.`,
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

function csvSet(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TandoorConfig {
  const telegramBotToken = env.TANDOOR_TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const allowedUserIds = csvSet(env.TANDOOR_ALLOWED_USER_IDS);
  const modelProvider = env.TANDOOR_MODEL_PROVIDER?.trim() || "openai-codex";
  const errors: string[] = [];
  const contextDevApiKey = env.TANDOOR_CONTEXT_DEV_API_KEY?.trim();
  const googleOAuthClientFile = env.TANDOOR_GOOGLE_OAUTH_CLIENT_FILE?.trim();
  const googleOAuthWebClientFile = env.TANDOOR_GOOGLE_OAUTH_WEB_CLIENT_FILE?.trim();
  const googleOAuthRedirectUri = env.TANDOOR_GOOGLE_OAUTH_REDIRECT_URI?.trim() ||
    DEFAULT_GOOGLE_OAUTH_REDIRECT_URI;
  const googleOAuthCallbackPort = Number(env.TANDOOR_GOOGLE_OAUTH_CALLBACK_PORT ?? "8787");

  if (!telegramBotToken) errors.push("TANDOOR_TELEGRAM_BOT_TOKEN is required.");
  if (allowedUserIds.size === 0) errors.push("Configure TANDOOR_ALLOWED_USER_IDS.");
  if (modelProvider !== "openai" && modelProvider !== "openai-codex" && modelProvider !== "xai") {
    errors.push("TANDOOR_MODEL_PROVIDER must be openai, openai-codex, or xai.");
  }
  if (contextDevApiKey && /[\r\n\0]/.test(contextDevApiKey)) {
    errors.push("TANDOOR_CONTEXT_DEV_API_KEY must be a single-line API key.");
  }
  if (googleOAuthClientFile) {
    const clientFile = resolve(googleOAuthClientFile);
    try {
      if (!statSync(clientFile).isFile()) throw new Error("not a regular file");
      accessSync(clientFile, constants.R_OK);
    } catch {
      errors.push("TANDOOR_GOOGLE_OAUTH_CLIENT_FILE must point to a readable Google OAuth client JSON file.");
    }
  }
  if (googleOAuthWebClientFile) {
    const clientFile = resolve(googleOAuthWebClientFile);
    try {
      if (!statSync(clientFile).isFile()) throw new Error("not a regular file");
      accessSync(clientFile, constants.R_OK);
    } catch {
      errors.push("TANDOOR_GOOGLE_OAUTH_WEB_CLIENT_FILE must point to a readable Google Web application OAuth client JSON file.");
    }
  }
  try {
    validateGoogleOAuthRedirectUri(googleOAuthRedirectUri);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "The Google OAuth redirect URI is invalid.");
  }
  if (
    !Number.isInteger(googleOAuthCallbackPort) ||
    googleOAuthCallbackPort < 1 ||
    googleOAuthCallbackPort > 65535
  ) {
    errors.push("TANDOOR_GOOGLE_OAUTH_CALLBACK_PORT must be an integer between 1 and 65535.");
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }

  return {
    telegramBotToken,
    allowedUserIds,
    dataDir: resolve(env.TANDOOR_DATA_DIR ?? join(homedir(), ".local", "share", "tandoor")),
    workerImage: env.TANDOOR_WORKER_IMAGE?.trim() || "localhost/tandoor-worker:dev",
    podman: env.TANDOOR_PODMAN?.trim() || "podman",
    modelProvider: modelProvider as "openai" | "openai-codex" | "xai",
    modelId:
      env.TANDOOR_MODEL_ID?.trim() ||
      (modelProvider === "openai"
        ? "gpt-6-luna"
        : modelProvider === "xai"
          ? "grok-4.3"
          : "gpt-6-luna"),
    ...(contextDevApiKey ? { contextDevApiKey } : {}),
    ...(googleOAuthClientFile
      ? { googleOAuthClientFile: resolve(googleOAuthClientFile) }
      : {}),
    ...(googleOAuthWebClientFile
      ? { googleOAuthWebClientFile: resolve(googleOAuthWebClientFile) }
      : {}),
    googleOAuthRedirectUri: validateGoogleOAuthRedirectUri(googleOAuthRedirectUri),
    googleOAuthCallbackPort,
  };
}
