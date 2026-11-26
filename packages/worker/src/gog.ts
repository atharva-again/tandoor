import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { IntegrationAdapter } from "./integrations.js";

const execFileAsync = promisify(execFile);
const GOG_TIMEOUT_MS = 120_000;
const GOOGLE_AUTH_TIMEOUT_MS = 60_000;
const GOOGLE_OAUTH_CLIENT_NAME = "tandoor-web";

export interface GogCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GogExecutionOptions {
  workspace: string;
  keyringPassword: string;
}

export interface GoogleOAuthStartResult {
  authUrl: string;
}

function assertCommandArgs(args: string[]): void {
  if (args.length === 0) throw new Error("Provide a gog command, for example `gmail search is:unread`.");
  if (args.some((arg) => arg.includes("\0"))) throw new Error("gog arguments must not contain NUL characters.");
  if (
    args[0] === "auth" &&
    args[1] === "tokens" &&
    args[2] === "export"
  ) {
    throw new Error("Exporting OAuth tokens is disabled.");
  }
}

function sanitizeGogOutput(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /([?&](?:access_token|refresh_token|id_token|client_secret|api_key|token|code|state)=)[^&#\s]+/gi,
      "$1[redacted]",
    )
    .replace(
      /(["']?(?:access_token|refresh_token|id_token|client_secret|authorization|password)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      "$1[redacted]",
    );
}

export function sanitizeGoogleAuthDiagnostic(value: string): string {
  return sanitizeGogOutput(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(" ")
    .slice(0, 600);
}

export function validateGoogleEmail(value: string): string {
  const email = value.trim();
  if (
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.includes("\0")
  ) {
    throw new Error("Send a valid Google account email address.");
  }
  return email;
}

export function validateGoogleCallbackUrl(value: string): string {
  const authUrl = value.trim();
  if (authUrl.length > 16_384) throw new Error("The Google sign in URL is too long.");
  let parsed: URL;
  try {
    parsed = new URL(authUrl);
  } catch {
    throw new Error("Send the full URL from the Google sign in page.");
  }
  const localHttp =
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !localHttp) ||
    parsed.username ||
    parsed.password ||
    (!parsed.searchParams.has("code") && !parsed.searchParams.has("error")) ||
    !parsed.searchParams.has("state")
  ) {
    throw new Error("Send the full URL from the Google sign in page.");
  }
  return authUrl;
}

function gogEnvironment(options: GogExecutionOptions): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: options.workspace,
    TMPDIR: "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    GOG_HOME: join(options.workspace, ".gogcli"),
    GOG_KEYRING_BACKEND: "file",
    GOG_KEYRING_PASSWORD: options.keyringPassword,
    DBUS_SESSION_BUS_ADDRESS: "disabled:",
  };
}

async function runGoogleAuthCommand(
  args: string[],
  options: GogExecutionOptions,
): Promise<string> {
  try {
    const result = await execFileAsync("gog", ["--no-input", "--json", ...args], {
      cwd: options.workspace,
      env: gogEnvironment(options),
      encoding: "utf8",
      timeout: GOOGLE_AUTH_TIMEOUT_MS,
      maxBuffer: 1_000_000,
    });
    return result.stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (failure.code === "ENOENT") {
      throw new Error("The gog executable is missing from this worker. Rebuild the worker image and try again.");
    }
    const diagnostic = sanitizeGoogleAuthDiagnostic(
      [failure.stderr ?? "", failure.stdout ?? ""].filter(Boolean).join("\n"),
    );
    if (diagnostic) throw new Error(diagnostic);
    throw error;
  }
}

export async function startGoogleOAuthLogin(
  emailValue: string,
  options: GogExecutionOptions & {
    googleOAuthWebClientFile?: string;
    googleOAuthRedirectUri: string;
  },
): Promise<GoogleOAuthStartResult> {
  if (!options.googleOAuthWebClientFile) {
    throw new Error("Google sign in needs a Web application OAuth client. Set TANDOOR_GOOGLE_OAUTH_WEB_CLIENT_FILE in .env and restart Tandoor.");
  }
  const email = validateGoogleEmail(emailValue);
  try {
    await runGoogleAuthCommand(
      [
        "--client",
        GOOGLE_OAUTH_CLIENT_NAME,
        "auth",
        "credentials",
        "set",
        options.googleOAuthWebClientFile,
      ],
      options,
    );
  } catch {
    throw new Error("Could not configure Google sign in. Check the OAuth client JSON file and try again.");
  }

  let output: string;
  try {
    output = await runGoogleAuthCommand(
      [
        "--client",
        GOOGLE_OAUTH_CLIENT_NAME,
        "auth",
        "add",
        email,
        "--services",
        "all-user",
        "--force-consent",
        "--remote",
        "--step",
        "1",
        "--redirect-uri",
        options.googleOAuthRedirectUri,
      ],
      options,
    );
  } catch {
    throw new Error("Could not start Google sign in. Check the OAuth consent screen and configured test users.");
  }

  try {
    const result: unknown = JSON.parse(output);
    if (
      typeof result !== "object" ||
      result === null ||
      !("auth_url" in result) ||
      typeof result.auth_url !== "string"
    ) {
      throw new Error("Missing Google authorization URL.");
    }
    const url = new URL(result.auth_url);
    if (url.protocol !== "https:" || url.hostname !== "accounts.google.com") {
      throw new Error("Unexpected Google authorization URL.");
    }
    return { authUrl: result.auth_url };
  } catch {
    throw new Error("Google did not return a valid sign in link. Check the OAuth client configuration.");
  }
}

export async function completeGoogleOAuthLogin(
  emailValue: string,
  authUrlValue: string,
  options: GogExecutionOptions & { googleOAuthRedirectUri: string },
): Promise<void> {
  const email = validateGoogleEmail(emailValue);
  const authUrl = validateGoogleCallbackUrl(authUrlValue);
  try {
    await runGoogleAuthCommand(
      [
        "--client",
        GOOGLE_OAUTH_CLIENT_NAME,
        "auth",
        "add",
        email,
        "--services",
        "all-user",
        "--force-consent",
        "--remote",
        "--step",
        "2",
        "--auth-url",
        authUrl,
        "--redirect-uri",
        options.googleOAuthRedirectUri,
      ],
      options,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    throw new Error(
      detail
        ? `Google could not finish sign in: ${detail}`
        : "Google could not finish sign in. Check the callback URL and try again.",
    );
  }
}

export async function executeGogCommand(
  args: string[],
  options: GogExecutionOptions,
  signal?: AbortSignal,
): Promise<GogCommandResult> {
  assertCommandArgs(args);
  const commandArgs = ["--no-input", "--json", "--wrap-untrusted", ...args];
  const env = gogEnvironment(options);

  try {
    const result = await execFileAsync("gog", commandArgs, {
      cwd: options.workspace,
      env,
      encoding: "utf8",
      timeout: GOG_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      exitCode: 0,
      stdout: sanitizeGogOutput(result.stdout),
      stderr: sanitizeGogOutput(result.stderr),
    };
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Google request cancelled.");
    }
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    if (failure.code === "ENOENT") {
      throw new Error("The gog executable is missing from this worker. Rebuild the worker image and try again.");
    }
    if (failure.stdout !== undefined || failure.stderr !== undefined || failure.killed) {
      return {
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        stdout: sanitizeGogOutput(failure.stdout ?? ""),
        stderr: sanitizeGogOutput(failure.stderr ?? failure.message),
      };
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createGogIntegrationAdapter(options: GogExecutionOptions): IntegrationAdapter {
  return {
    id: "gog",
    async execute(operation, payload, signal) {
      if (operation !== "command") throw new Error(`Unsupported gog operation: ${operation}`);
      if (
        !isRecord(payload) ||
        !Array.isArray(payload.args) ||
        !payload.args.every((arg) => typeof arg === "string")
      ) {
        throw new Error("The gog command payload is invalid.");
      }
      return executeGogCommand(
        payload.args,
        options,
        signal,
      );
    },
  };
}
