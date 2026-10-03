import { describe, expect, it, vi } from "vitest";
import { MemoryCredentialStore } from "@main/security/credential-store";
import { searchWeb, webSearchCredentialKey } from "@main/integrations/web-search";

describe("web search skill provider selection", () => {
  it("uses an available provider and returns normalized source records", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set(webSearchCredentialKey("tavily"), "tvly-test");
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Primary documentation",
              url: "https://docs.example.test/reference",
              content: "  Current reference content.  ",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as typeof fetch;

    await expect(
      searchWeb({ credentials, query: "current API reference", fetcher }),
    ).resolves.toEqual({
      provider: "tavily",
      query: "current API reference",
      results: [
        {
          title: "Primary documentation",
          url: "https://docs.example.test/reference",
          snippet: "Current reference content.",
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("falls back when the preferred configured provider fails", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set(webSearchCredentialKey("exa"), "exa-test");
    await credentials.set(webSearchCredentialKey("tavily"), "tvly-test");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as typeof fetch;

    const result = await searchWeb({
      credentials,
      query: "fallback",
      preferredProvider: "exa",
      fetcher,
    });
    expect(result.provider).toBe("tavily");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  const firecrawlResponse = () =>
    new Response(
      JSON.stringify({
        success: true,
        data: {
          web: [{ url: "https://news.example.test/launch", title: "Launch", description: "Shipped today.", position: 1 }],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("searches Firecrawl's free tier without a key when none is configured", async () => {
    const fetcher = vi.fn(async () => firecrawlResponse()) as typeof fetch;

    await expect(
      searchWeb({ credentials: new MemoryCredentialStore(), query: "launch news", limit: 3, fetcher }),
    ).resolves.toEqual({
      provider: "firecrawl",
      query: "launch news",
      results: [{ title: "Launch", url: "https://news.example.test/launch", snippet: "Shipped today." }],
    });
    const [url, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(url).toBe("https://api.firecrawl.dev/v2/search");
    expect(init?.headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(String(init?.body))).toEqual({ query: "launch news", limit: 3 });
  });

  it("sends a saved Firecrawl key", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set(webSearchCredentialKey("firecrawl"), "fc-test");
    const fetcher = vi.fn(async () => firecrawlResponse()) as typeof fetch;

    const result = await searchWeb({ credentials, query: "launch news", fetcher });

    expect(result.provider).toBe("firecrawl");
    expect(result.results).toHaveLength(1);
    expect(vi.mocked(fetcher).mock.calls[0]![1]?.headers).toMatchObject({ Authorization: "Bearer fc-test" });
  });

  it("explains how to keep searching once the free daily limit is used up", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 429 })) as typeof fetch;

    await expect(
      searchWeb({ credentials: new MemoryCredentialStore(), query: "anything", fetcher }),
    ).rejects.toThrow(/free search limit for today is used up.*Settings → Web search/);
  });

  it("does not fall back to the free tier when configured providers fail", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set(webSearchCredentialKey("tavily"), "tvly-test");
    const fetcher = vi.fn(async () => new Response("{}", { status: 503 })) as typeof fetch;

    await expect(searchWeb({ credentials, query: "anything", fetcher })).rejects.toThrow(
      "All configured search providers failed",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
