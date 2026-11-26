import { resolve } from "node:path";
import type { WorkerScope } from "../../shared/src/scope.js";
import {
  DEFAULT_GOOGLE_OAUTH_REDIRECT_URI,
  FIXED_MODEL_ID,
  FIXED_MODEL_PROVIDER,
  validateGoogleOAuthRedirectUri,
} from "../../shared/src/config.js";

export interface WorkerConfig {
  dataDir: string;
  modelProvider: typeof FIXED_MODEL_PROVIDER;
  modelId: typeof FIXED_MODEL_ID;
  port: number;
  authToken: string;
  gogKeyringPassword: string;
  contextWebEnabled: boolean;
  googleOAuthClientFile?: string;
  googleOAuthWebClientFile?: string;
  googleOAuthRedirectUri: string;
  scope: WorkerScope;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const port = Number(env.TANDOOR_WORKER_PORT ?? "50051");
  const authToken = env.TANDOOR_WORKER_AUTH_TOKEN?.trim() ?? "";
  const scopeKind = env.TANDOOR_SCOPE_KIND?.trim() || "user";
  const scopeId = env.TANDOOR_SCOPE_ID?.trim() || "local";
  const gogKeyringPassword = env.TANDOOR_GOG_KEYRING_PASSWORD?.trim() || authToken;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("TANDOOR_WORKER_PORT must be an integer between 1 and 65535.");
  }
  if (!authToken) throw new Error("TANDOOR_WORKER_AUTH_TOKEN is required.");
  if (scopeKind !== "user") {
    throw new Error("TANDOOR_SCOPE_KIND must be user.");
  }
  if (!scopeId) throw new Error("TANDOOR_SCOPE_ID must not be empty.");
  if (!gogKeyringPassword) throw new Error("A Gog keyring password could not be configured.");
  return {
    dataDir: resolve(env.TANDOOR_DATA_DIR ?? "/tandoor"),
    modelProvider: FIXED_MODEL_PROVIDER,
    modelId: FIXED_MODEL_ID,
    port,
    authToken,
    gogKeyringPassword,
    contextWebEnabled: env.TANDOOR_CONTEXT_WEB_ENABLED === "true",
    ...(env.TANDOOR_GOOGLE_OAUTH_CLIENT_FILE?.trim()
      ? { googleOAuthClientFile: env.TANDOOR_GOOGLE_OAUTH_CLIENT_FILE.trim() }
      : {}),
    ...(env.TANDOOR_GOOGLE_OAUTH_WEB_CLIENT_FILE?.trim()
      ? { googleOAuthWebClientFile: env.TANDOOR_GOOGLE_OAUTH_WEB_CLIENT_FILE.trim() }
      : {}),
    googleOAuthRedirectUri: validateGoogleOAuthRedirectUri(
      env.TANDOOR_GOOGLE_OAUTH_REDIRECT_URI?.trim() || DEFAULT_GOOGLE_OAUTH_REDIRECT_URI,
    ),
    scope: { kind: scopeKind, id: scopeId },
  };
}
