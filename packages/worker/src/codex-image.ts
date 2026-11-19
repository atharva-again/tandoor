import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { arr, bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { telegramEntriesForRun } from "./actor-context.js";

const PROVIDER = "openai-codex";
const ROUTER_MODEL = "gpt-5.6-luna";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const MAX_ATTEMPTS = 4;
const MAX_REFERENCE_IMAGES = 4;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 50 * 1024 * 1024;
const IMAGE_MODELS = ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"] as const;
const QUALITIES = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
const BACKGROUNDS = ["auto", "opaque", "transparent"] as const;
const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const REFERENCE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export interface CodexImageReference {
  data: string;
  mimeType: string;
  source: string;
}

export interface CodexImageToolOptions {
  workspace: string;
  fetch?: typeof fetch;
}

const parameters = obj({
  prompt: str({ description: "A detailed description of the image to generate or the edit to make." }),
  imageModel: opt(oneOf(IMAGE_MODELS, { description: "GPT Image model. Sunburst prioritizes precision; Flare is faster." })),
  quality: opt(oneOf(QUALITIES, { description: "Rendering quality. Defaults to auto." })),
  size: opt(str({ description: "Image dimensions as auto or WIDTHxHEIGHT, for example 1536x1024." })),
  background: opt(oneOf(BACKGROUNDS, { description: "Background mode. Transparent backgrounds require PNG or WebP." })),
  outputFormat: opt(oneOf(OUTPUT_FORMATS, { description: "Generated file format. Defaults to PNG." })),
  outputCompression: opt(int({ minimum: 0, maximum: 100, description: "JPEG or WebP compression from 0 to 100." })),
  imagePaths: opt(arr(str(), {
    maxItems: MAX_REFERENCE_IMAGES,
    description: "Optional workspace image paths to use as references or edit. Supports PNG, JPEG, WebP, and GIF.",
  })),
  useAttachedImages: opt(bool({
    description: "Use images attached to the latest Telegram message as references. Defaults to true.",
  })),
});

type ImageToolArgs = {
  prompt: string;
  imageModel?: (typeof IMAGE_MODELS)[number];
  quality?: (typeof QUALITIES)[number];
  size?: string;
  background?: (typeof BACKGROUNDS)[number];
  outputFormat?: (typeof OUTPUT_FORMATS)[number];
  outputCompression?: number;
  imagePaths?: string[];
  useAttachedImages?: boolean;
};

interface ParsedCodexResponse {
  text: string[];
  finalText: string;
  image?: { id: string; result: string; revisedPrompt?: string };
  imageFailure?: { status: string; message?: string };
  responseError?: string;
}

class CodexHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "CodexHttpError";
  }
}

function decodedBase64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}

function normalizeMimeType(value: string): string {
  return value.toLowerCase() === "image/jpg" ? "image/jpeg" : value.toLowerCase();
}

function validateReferenceImage(image: CodexImageReference): CodexImageReference {
  const mimeType = normalizeMimeType(image.mimeType);
  if (!REFERENCE_IMAGE_MIMES.has(mimeType)) {
    throw new Error(`Unsupported reference image type ${image.mimeType} from ${image.source}. Use PNG, JPEG, WebP, or GIF.`);
  }
  if (!image.data) throw new Error(`Reference image ${image.source} is empty.`);
  const bytes = decodedBase64Bytes(image.data);
  if (bytes > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(`Reference image ${image.source} is too large. The maximum size is 20 MB.`);
  }
  return { ...image, mimeType };
}

function mimeTypeForPath(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg":
    case ".jfif": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return undefined;
  }
}

function isWithin(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath);
}

async function loadReferenceImage(rawPath: string, workspace: string): Promise<CodexImageReference> {
  const normalizedPath = rawPath.trim().replace(/^@/, "");
  if (!normalizedPath) throw new Error("Reference image path cannot be empty.");
  const candidate = isAbsolute(normalizedPath) ? resolve(normalizedPath) : resolve(workspace, normalizedPath);
  const path = await realpath(candidate);
  const root = await realpath(workspace);
  if (!isWithin(root, path)) {
    throw new Error("Reference images must be inside Tandoor's workspace.");
  }
  const mimeType = mimeTypeForPath(path);
  if (!mimeType) throw new Error(`Unsupported reference image extension: ${rawPath}. Use PNG, JPEG, WebP, or GIF.`);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Reference image is not a file: ${rawPath}.`);
  if (info.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(`Reference image ${rawPath} is too large. The maximum size is 20 MB.`);
  }
  return validateReferenceImage({
    data: (await readFile(path)).toString("base64"),
    mimeType,
    source: path,
  });
}

function deduplicateImages(images: readonly CodexImageReference[]): CodexImageReference[] {
  const seen = new Set<string>();
  return images.filter((image) => {
    const digest = createHash("sha256").update(image.mimeType).update("\0").update(image.data).digest("hex");
    if (seen.has(digest)) return false;
    seen.add(digest);
    return true;
  });
}

function validateSize(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().toLowerCase() === "auto") return value?.trim().toLowerCase();
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match) throw new Error("Invalid size. Use auto or WIDTHxHEIGHT, for example 1536x1024.");
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const ratio = width / height;
  if (width % 16 !== 0 || height % 16 !== 0) {
    throw new Error("Invalid size. Width and height must be multiples of 16.");
  }
  if (ratio < 1 / 3 || ratio > 3 || width > 3840 || height > 3840) {
    throw new Error("Invalid size. Aspect ratio must be between 1:3 and 3:1, with neither edge over 3840 pixels.");
  }
  if (pixels < 655_360 || pixels > 8_294_400) {
    throw new Error("Invalid size. Total pixel count must be between 655,360 and 8,294,400.");
  }
  return `${width}x${height}`;
}

function accountIdFromToken(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("The OpenAI Codex OAuth token is invalid. Run /login_provider and sign in to OpenAI Codex again.");
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("The OpenAI Codex OAuth token is invalid. Run /login_provider and sign in to OpenAI Codex again.");
  }
  const auth = payload[JWT_CLAIM_PATH];
  const accountId =
    typeof auth === "object" && auth !== null && "chatgpt_account_id" in auth
      ? auth.chatgpt_account_id
      : undefined;
  if (typeof accountId !== "string" || !accountId) {
    throw new Error("The OpenAI Codex OAuth token is missing its account information. Run /login_provider again.");
  }
  return accountId;
}

function sanitizeRemoteMessage(message: string): string {
  return message
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /([?&](?:access_token|refresh_token|id_token|client_secret|api_key|token|code|state)=)[^&#\s]+/gi,
      "$1[redacted]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function shouldRetry(error: unknown): boolean {
  if (error instanceof CodexHttpError) {
    return error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/usage_limit_reached|safety system|moderation[_ -]?blocked|image_generation_user_error|not supported|invalid[_ -]?request|authentication|unauthori[sz]ed|forbidden/i.test(message)) {
    return false;
  }
  return /\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|server[_ -]?error|internal[_ -]?server|processing your request|you can retry your request|temporar(?:y|ily)|rate.?limit|overload|service.?unavailable|upstream.?connect|connection.?refused|timeout|stream ended|network|fetch failed/i.test(message);
}

function retryDelay(attempt: number, error: unknown): number {
  const exponential = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
  return Math.max(exponential, error instanceof CodexHttpError ? error.retryAfterMs ?? 0 : 0);
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Image generation was cancelled.");
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      rejectPromise(signal.reason instanceof Error ? signal.reason : new Error("Image generation was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseSseData(block: string): string | undefined {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
    .trim();
  return data && data !== "[DONE]" ? data : undefined;
}

function inspectOutputItem(item: unknown, parsed: ParsedCodexResponse): void {
  if (typeof item !== "object" || item === null) return;
  const record = item as Record<string, unknown>;
  if (record.type === "image_generation_call") {
    if (typeof record.result === "string" && record.result) {
      parsed.image = {
        id: typeof record.id === "string" ? record.id : "generated-image",
        result: record.result,
        ...(typeof record.revised_prompt === "string" ? { revisedPrompt: record.revised_prompt } : {}),
      };
    } else {
      const error = record.error;
      parsed.imageFailure = {
        status: typeof record.status === "string" ? record.status : "failed",
        ...(typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
          ? { message: error.message }
          : {}),
      };
    }
  }
  if (record.type === "message" && Array.isArray(record.content)) {
    parsed.finalText = record.content
      .flatMap((part) =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "output_text" &&
        "text" in part &&
        typeof part.text === "string"
          ? [part.text]
          : [],
      )
      .join("");
  }
}

function handleSseEvent(event: unknown, parsed: ParsedCodexResponse): void {
  if (typeof event !== "object" || event === null) return;
  const record = event as Record<string, unknown>;
  if (record.type === "error") {
    throw new Error(`Codex error: ${sanitizeRemoteMessage(String(record.message ?? record.code ?? "Unknown error"))}`);
  }
  if (record.type === "response.failed") {
    const response = record.response as Record<string, unknown> | undefined;
    const error =
      typeof response === "object" && response !== null && "error" in response
        ? response.error
        : undefined;
    const message =
      typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : "Codex image generation failed.";
    throw new Error(sanitizeRemoteMessage(message));
  }
  if (record.type === "response.output_text.delta" && typeof record.delta === "string") {
    parsed.text.push(record.delta);
  }
  if (record.type === "response.output_item.done") inspectOutputItem(record.item, parsed);
  if (record.type === "response.completed") {
    const response = record.response as Record<string, unknown> | undefined;
    if (typeof response !== "object" || response === null) return;
    if (Array.isArray(response.output)) {
      for (const item of response.output) inspectOutputItem(item, parsed);
    }
    const responseError = response.error;
    if (
      typeof responseError === "object" &&
      responseError !== null &&
      "message" in responseError &&
      typeof responseError.message === "string"
    ) {
      parsed.responseError = responseError.message;
    }
  }
}

export async function parseCodexImageSse(response: Response, signal?: AbortSignal): Promise<ParsedCodexResponse> {
  if (!response.body) throw new Error("Codex image generation returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parsed: ParsedCodexResponse = { text: [], finalText: "" };
  let buffer = "";
  const consume = (block: string) => {
    const data = parseSseData(block);
    if (data) handleSseEvent(JSON.parse(data) as unknown, parsed);
  };

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Image generation was cancelled.");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) consume(block);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed.
    }
    reader.releaseLock();
  }
  return parsed;
}

function buildRequestBody(
  prompt: string,
  conversationId: number,
  referenceImages: readonly CodexImageReference[],
  imageModel: (typeof IMAGE_MODELS)[number],
  quality: (typeof QUALITIES)[number],
  size: string | undefined,
  background: (typeof BACKGROUNDS)[number],
  outputFormat: (typeof OUTPUT_FORMATS)[number],
  outputCompression: number | undefined,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: prompt }];
  for (const image of referenceImages) {
    content.push({
      type: "input_image",
      detail: "auto",
      image_url: `data:${image.mimeType};base64,${image.data}`,
    });
  }
  const imageTool: Record<string, unknown> = {
    type: "image_generation",
    model: imageModel,
    output_format: outputFormat,
    quality,
    background,
    ...(size ? { size } : {}),
    ...(outputCompression !== undefined ? { output_compression: outputCompression } : {}),
  };
  return {
    model: ROUTER_MODEL,
    store: false,
    stream: true,
    prompt_cache_key: `tandoor-${conversationId}`,
    instructions: referenceImages.length > 0
      ? "You generate or edit bitmap image assets. Use the supplied references as requested. Call image_generation exactly once. If it fails, explain the reason briefly."
      : "You generate bitmap image assets. Call image_generation exactly once. If it fails, explain the reason briefly.",
    input: [{ role: "user", content }],
    tools: [imageTool],
    tool_choice: "auto",
    parallel_tool_calls: false,
    text: { verbosity: "low" },
  };
}

function backendFailureMessage(parsed: ParsedCodexResponse): string {
  const reason = parsed.imageFailure?.message ?? parsed.responseError ?? (parsed.finalText || parsed.text.join(""));
  const status = parsed.imageFailure?.status ? ` (${parsed.imageFailure.status})` : "";
  return reason
    ? `Codex image generation failed${status}: ${sanitizeRemoteMessage(reason)}`
    : `Codex image generation failed${status}. No image was returned.`;
}

async function requestImage(
  args: ImageToolArgs,
  token: string,
  accountId: string,
  conversationId: number,
  referenceImages: readonly CodexImageReference[],
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<ParsedCodexResponse> {
  const outputFormat = args.outputFormat ?? "png";
  const imageModel = args.imageModel ?? IMAGE_MODELS[0];
  const body = JSON.stringify(buildRequestBody(
    args.prompt,
    conversationId,
    referenceImages,
    imageModel,
    args.quality ?? "auto",
    validateSize(args.size),
    args.background ?? "auto",
    outputFormat,
    args.outputCompression,
  ));
  if (args.outputCompression !== undefined && outputFormat === "png") {
    throw new Error("Output compression is supported only for JPEG or WebP.");
  }
  if (args.background === "transparent" && outputFormat === "jpeg") {
    throw new Error("Transparent backgrounds are not supported with JPEG. Choose PNG or WebP.");
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Image generation was cancelled.");
    try {
      const response = await fetchImpl(CODEX_RESPONSES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "chatgpt-account-id": accountId,
          originator: "tandoor",
          "OpenAI-Beta": "responses=experimental",
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body,
        signal,
      });
      if (!response.ok) {
        const remote = sanitizeRemoteMessage(await response.text().catch(() => ""));
        const explanation = response.status === 401
    ? "Codex rejected the OAuth session. Run /login_provider and sign in to OpenAI Codex again."
          : remote || response.statusText || "The Codex service returned an error.";
        throw new CodexHttpError(
          response.status,
          `Codex image generation failed (${response.status}): ${explanation}`,
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }
      const parsed = await parseCodexImageSse(response, signal);
      if (parsed.image) {
        if (decodedBase64Bytes(parsed.image.result) > MAX_GENERATED_IMAGE_BYTES) {
          throw new Error("The generated image exceeds Telegram's 50 MB upload limit.");
        }
        return parsed;
      }
      const failure = new Error(backendFailureMessage(parsed));
      if (attempt === MAX_ATTEMPTS || !shouldRetry(failure)) throw failure;
      await waitForRetry(retryDelay(attempt, failure), signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Image generation was cancelled.");
      if (attempt === MAX_ATTEMPTS || !shouldRetry(error)) throw error;
      await waitForRetry(retryDelay(attempt, error), signal);
    }
  }
  throw new Error("Codex image generation failed after repeated attempts.");
}

async function saveGeneratedImage(
  imageBase64: string,
  format: (typeof OUTPUT_FORMATS)[number],
  workspace: string,
): Promise<string> {
  const extension = format === "jpeg" ? "jpg" : format;
  const directory = join(workspace, "generated-images");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = `${randomUUID()}.${extension}`;
  const path = join(directory, filename);
  await writeFile(path, Buffer.from(imageBase64, "base64"), { flag: "wx", mode: 0o600 });
  return `generated-images/${filename}`;
}

export function createCodexImageTool(options: CodexImageToolOptions) {
  const fetchImpl = options.fetch ?? fetch;
  return defineTool({
    name: "codex_generate_image",
    description:
      "Generate or edit an image using GPT Image 2.5 through the user's OpenAI Codex OAuth login. " +
      "Use this when asked to create or edit images. Images attached to the latest Telegram message are included automatically as references.",
    parameters,
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args: ImageToolArgs, api, context: Context) {
      const auth = await api.models.getAuth(
        PROVIDER,
        context.abortSignal ? { signal: context.abortSignal } : {},
      );
      const token = auth?.auth.apiKey;
      if (!token) {
    throw new Error("OpenAI Codex is not signed in. Run /login_provider, choose OpenAI Codex, and try again.");
      }
      const accountId = accountIdFromToken(token);
      const workspace = await realpath(options.workspace);
      const pathImages = await Promise.all(
        (args.imagePaths ?? []).map((path) => loadReferenceImage(path, workspace)),
      );
      const attachedImages = args.useAttachedImages === false
        ? []
        : latestUserImageReferences(
            (await telegramEntriesForRun(api, context)).flatMap((entry) => entry.model ?? []),
          );
      const referenceImages = deduplicateImages([...pathImages, ...attachedImages]);
      if (referenceImages.length > MAX_REFERENCE_IMAGES) {
        throw new Error(`Too many reference images. Use at most ${MAX_REFERENCE_IMAGES}.`);
      }
      const timeout = AbortSignal.timeout(3 * 60 * 1000);
      const signal = context.abortSignal
        ? AbortSignal.any([context.abortSignal, timeout])
        : timeout;
      const outputFormat = args.outputFormat ?? "png";
      const parsed = await requestImage(
        args,
        token,
        accountId,
        Number(api.conversationId),
        referenceImages,
        signal,
        fetchImpl,
      );
      if (!parsed.image) throw new Error(backendFailureMessage(parsed));
      const relativePath = await saveGeneratedImage(parsed.image.result, outputFormat, workspace);
      return {
        output: [{
          type: "text" as const,
          text: [
            `Generated image saved to ${relativePath}.`,
            `MEDIA:${relativePath}`,
          ].join("\n"),
        }],
        details: {
          provider: PROVIDER,
          imageModel: args.imageModel ?? IMAGE_MODELS[0],
          quality: args.quality ?? "auto",
          size: args.size ?? "auto",
          background: args.background ?? "auto",
          outputFormat,
          referenceImageCount: referenceImages.length,
          relativePath,
        },
      };
    },
  });
}

export function latestUserImageReferences(
  messages: readonly { role: string; content: unknown }[],
): CodexImageReference[] {
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  if (!latestUser || !Array.isArray(latestUser.content)) return [];
  return latestUser.content.flatMap((part, index) => {
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "image" &&
      "data" in part &&
      typeof part.data === "string" &&
      "mimeType" in part &&
      typeof part.mimeType === "string"
    ) {
      return [validateReferenceImage({
        data: part.data,
        mimeType: part.mimeType,
        source: `latest Telegram attachment ${index + 1}`,
      })];
    }
    return [];
  });
}
