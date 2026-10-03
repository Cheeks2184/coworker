import { z } from "zod";
import { webSearchProviders, type WebSearchProvider } from "@shared/contracts";
import type { CredentialStore } from "@main/security/credential-store";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function webSearchCredentialKey(provider: WebSearchProvider): string {
  return `web-search:${provider}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 4_000) : "";
}

function normalizeResults(value: unknown): WebSearchResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const url = text(record.url ?? record.link);
    if (!/^https?:\/\//i.test(url)) return [];
    return [{
      title: text(record.title ?? record.name) || url,
      url,
      snippet: text(record.content ?? record.text ?? record.snippet ?? record.description),
    }];
  });
}

async function jsonResponse(response: Response, provider: WebSearchProvider): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${provider} returned an invalid search response`);
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body ? text(body.error) : "";
    throw new Error(`${provider} search failed (${response.status})${message ? `: ${message}` : ""}`);
  }
  return body;
}

async function searchProvider(
  provider: WebSearchProvider,
  apiKey: string,
  query: string,
  limit: number,
  fetcher: typeof fetch,
): Promise<WebSearchResult[]> {
  const signal = AbortSignal.timeout(20_000);
  if (provider === "tavily") {
    const response = await fetcher("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: limit, search_depth: "advanced" }),
      signal,
    });
    const body = (await jsonResponse(response, provider)) as { results?: unknown };
    return normalizeResults(body.results);
  }
  if (provider === "exa") {
    const response = await fetcher("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ query, numResults: limit, contents: { text: { maxCharacters: 2_000 } } }),
      signal,
    });
    const body = (await jsonResponse(response, provider)) as { results?: unknown };
    return normalizeResults(body.results);
  }
  if (provider === "firecrawl") return searchFirecrawl(apiKey, query, limit, fetcher);
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("num", String(limit));
  const response = await fetcher(url, { signal });
  const body = (await jsonResponse(response, provider)) as { organic_results?: unknown };
  return normalizeResults(body.organic_results);
}

/** Without a key, Firecrawl serves a free tier capped per IP address per day. */
async function searchFirecrawl(
  apiKey: string | null,
  query: string,
  limit: number,
  fetcher: typeof fetch,
): Promise<WebSearchResult[]> {
  const response = await fetcher("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ query, limit }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!apiKey && response.status === 429) {
    throw new Error(
      "Firecrawl's free search limit for today is used up. Add a free Firecrawl API key, or a Tavily, Exa, or SerpAPI key, in Settings → Web search to keep searching.",
    );
  }
  const body = (await jsonResponse(response, "firecrawl")) as { data?: { web?: unknown } };
  return normalizeResults(body.data?.web);
}

export async function searchWeb(input: {
  credentials: CredentialStore;
  query: string;
  limit?: number;
  preferredProvider?: WebSearchProvider;
  fetcher?: typeof fetch;
}): Promise<{ provider: WebSearchProvider; query: string; results: WebSearchResult[] }> {
  const query = z.string().trim().min(1).max(2_000).parse(input.query);
  const limit = z.number().int().min(1).max(10).default(5).parse(input.limit);
  const order = input.preferredProvider
    ? [input.preferredProvider, ...webSearchProviders.filter((item) => item !== input.preferredProvider)]
    : [...webSearchProviders];
  const failures: string[] = [];
  for (const provider of order) {
    const apiKey = await input.credentials.get(webSearchCredentialKey(provider));
    if (!apiKey) continue;
    try {
      const results = await searchProvider(provider, apiKey, query, limit, input.fetcher ?? fetch);
      return { provider, query, results };
    } catch (error) {
      failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`All configured search providers failed. ${failures.join("; ")}`);
  // Reaching here means no key is configured; Firecrawl's free tier needs none.
  const results = await searchFirecrawl(null, query, limit, input.fetcher ?? fetch);
  return { provider: "firecrawl", query, results };
}
