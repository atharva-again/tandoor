import ContextDev from "context.dev";
import type { WebSearchResponse as ProviderSearchResponse, WebScrapeResponse } from "context.dev/resources/web";
import { validatePublicWebUrl } from "../../shared/src/web-url.js";
import {
  isWebFreshness,
  WEB_LIMITS,
  type WebFreshness,
  type WebSearchResponse,
  type WebFetchResponse,
} from "../../shared/src/web-contract.js";

type ContextWebClient = Pick<ContextDev["web"], "search" | "scrape">;
class InvalidWebRequest extends Error {}

interface FindPayload {
  query: string;
  limit: number;
  freshness?: WebFreshness;
}

interface FetchPayload {
  url: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isIntegerWithin(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum;
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) return { text: value.slice(0, end), truncated: true };
    bytes += characterBytes;
    end += character.length;
  }
  return { text: value, truncated: false };
}

function parsePayload(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    throw new InvalidWebRequest("The web request payload is invalid.");
  }
}

function parseFindPayload(value: unknown): FindPayload {
  if (!isRecord(value)) {
    throw new InvalidWebRequest("The web search request is invalid.");
  }
  const query = value.query;
  const limit = value.limit;
  if (
    typeof query !== "string" ||
    query.trim().length === 0 ||
    query.length > WEB_LIMITS.queryLength ||
    !isIntegerWithin(limit, 1, WEB_LIMITS.resultCount)
  ) {
    throw new InvalidWebRequest("The web search request is invalid.");
  }
  if (value.freshness !== undefined && !isWebFreshness(value.freshness)) {
    throw new InvalidWebRequest("The web search request is invalid.");
  }
  return {
    query: query.trim(),
    limit,
    ...(isWebFreshness(value.freshness) ? { freshness: value.freshness } : {}),
  };
}

function parseFetchPayload(value: unknown): FetchPayload {
  if (!isRecord(value) || typeof value.url !== "string" || value.url.length > WEB_LIMITS.fetchUrlLength) {
    throw new InvalidWebRequest("The web fetch request is invalid.");
  }
  try {
    return { url: validatePublicWebUrl(value.url) };
  } catch (error) {
    throw new InvalidWebRequest(error instanceof Error ? error.message : "The web fetch URL is invalid.");
  }
}

function minimizeSearchResponse(response: ProviderSearchResponse): WebSearchResponse {
  const results = response.results.slice(0, WEB_LIMITS.resultCount).flatMap((result) => {
    const url = safeString(result.url, WEB_LIMITS.fetchUrlLength);
    if (!url || !/^https?:\/\//i.test(url)) return [];
    return [{
      title: safeString(result.title, 300) ?? "",
      url,
      description: safeString(result.description, WEB_LIMITS.descriptionLength) ?? "",
      relevance: safeString(result.relevance, 20) ?? "",
    }];
  });
  return {
    query: safeString(response.query, WEB_LIMITS.queryLength) ?? "",
    results,
    requestId: safeString(response.request_id, 100) ?? "",
    partial: response.partial === true,
  };
}

function minimizeScrapeResponse(response: WebScrapeResponse, requestedUrl: string): WebFetchResponse {
  let content: WebFetchResponse["content"];
  if (response.markdown.success === true && typeof response.markdown.data === "string") {
    const bounded = truncateUtf8(response.markdown.data, WEB_LIMITS.fetchOutputBytes);
    content = {
      success: true,
      markdown: bounded.text,
      truncated: bounded.truncated,
    };
  } else {
    content = {
      success: false,
      code: safeString(response.markdown.error_code, 100) ?? "",
      message: safeString(response.markdown.message, 300) ?? "",
    };
  }
  return {
    url: safeString(response.url, WEB_LIMITS.fetchUrlLength) ?? requestedUrl,
    content,
    title: safeString(response.metadata.title, 300) ?? "",
    requestId: safeString(response.request_id, 100) ?? "",
    partial: response.isPartial === true,
  };
}

function safeProviderError(error: unknown): string {
  if (isRecord(error) && typeof error.status === "number") {
    return `Context.dev returned HTTP ${error.status}.`;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "The Context.dev request was cancelled or timed out.";
  }
  return "The Context.dev request failed. Check the API key, quota, or try again later.";
}

/** Runs Context.dev calls in the gateway so the shared API key never enters worker containers. */
export class ContextWebService {
  private readonly client: ContextWebClient | undefined;

  constructor(apiKey?: string, client?: ContextWebClient) {
    this.client =
      client ??
      (apiKey?.trim()
        ? new ContextDev({
            apiKey: apiKey.trim(),
            timeout: 100_000,
            maxRetries: 0,
            logLevel: "off",
          }).web
        : undefined);
  }

  async execute(
    integrationId: string,
    operation: string,
    payloadJson: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (integrationId !== "context_web") throw new Error("The requested service integration is unavailable.");
    if (!this.client) throw new Error("Context.dev web access is not configured.");

    try {
      if (operation === "find") {
        const payload = parseFindPayload(parsePayload(payloadJson));
        const response = await this.client.search(
          {
            query: payload.query,
            numResults: payload.limit,
            descriptionMaxCharacters: WEB_LIMITS.descriptionLength,
            ...(payload.freshness ? { freshness: payload.freshness } : {}),
          },
          { signal, timeout: 35_000, maxRetries: 0 },
        );
        return JSON.stringify(minimizeSearchResponse(response));
      }

      if (operation === "fetch") {
        const payload = parseFetchPayload(parsePayload(payloadJson));
        const response = await this.client.scrape(
          {
            url: payload.url,
            formats: { markdown: true },
            markdownParams: { includeLinks: true, includeImages: false },
            sharedParams: { mainContentOnly: true },
            maxAgeMs: 0,
            timeoutOpts: { milliseconds: 75_000, behavior: "return-partial" },
          },
          { signal, timeout: 90_000, maxRetries: 0 },
        );
        return JSON.stringify(minimizeScrapeResponse(response, payload.url));
      }

      throw new InvalidWebRequest("The requested web operation is unavailable.");
    } catch (error) {
      if (error instanceof InvalidWebRequest) throw error;
      throw new Error(safeProviderError(error));
    }
  }
}
