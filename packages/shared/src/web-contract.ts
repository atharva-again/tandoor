export const WEB_LIMITS = {
  queryLength: 500,
  fetchUrlLength: 2_048,
  resultCount: 10,
  descriptionLength: 600,
  fetchOutputBytes: 24_000,
} as const;

export const WEB_FRESHNESS_OPTIONS = [
  "last_24_hours",
  "last_week",
  "last_month",
  "last_year",
] as const;

export type WebFreshness = (typeof WEB_FRESHNESS_OPTIONS)[number];

export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
  relevance: string;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  requestId: string;
  partial: boolean;
}

export interface WebFetchResponse {
  url: string;
  title: string;
  requestId: string;
  partial: boolean;
  content:
    | { success: true; markdown: string; truncated: boolean }
    | { success: false; code: string; message: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWebSearchResult(value: unknown): value is WebSearchResult {
  return isRecord(value) && typeof value.title === "string" && typeof value.url === "string" &&
    typeof value.description === "string" && typeof value.relevance === "string";
}

export function parseWebSearchResponse(value: unknown): WebSearchResponse {
  if (
    !isRecord(value) || typeof value.query !== "string" ||
    typeof value.requestId !== "string" || typeof value.partial !== "boolean" ||
    !Array.isArray(value.results) ||
    !value.results.every(isWebSearchResult)
  ) throw new Error("The web service returned an invalid search response.");
  return {
    query: value.query,
    requestId: value.requestId,
    partial: value.partial,
    results: value.results.map((result) => ({
      title: result.title, url: result.url, description: result.description, relevance: result.relevance,
    })),
  };
}

export function parseWebFetchResponse(value: unknown): WebFetchResponse {
  if (
    !isRecord(value) || typeof value.url !== "string" || typeof value.title !== "string" ||
    typeof value.requestId !== "string" || typeof value.partial !== "boolean" ||
    !isRecord(value.content)
  ) throw new Error("The web service returned an invalid page response.");
  const content = value.content;
  let parsed: WebFetchResponse["content"];
  if (content.success === true && typeof content.markdown === "string" && typeof content.truncated === "boolean") {
    parsed = { success: true, markdown: content.markdown, truncated: content.truncated };
  } else if (content.success === false && typeof content.code === "string" && typeof content.message === "string") {
    parsed = { success: false, code: content.code, message: content.message };
  } else {
    throw new Error("The web service returned invalid page content.");
  }
  return { url: value.url, title: value.title, requestId: value.requestId, partial: value.partial, content: parsed };
}

const freshnessOptions: ReadonlySet<string> = new Set(WEB_FRESHNESS_OPTIONS);

export function isWebFreshness(value: unknown): value is WebFreshness {
  return typeof value === "string" && freshnessOptions.has(value);
}
