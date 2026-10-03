import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { DesktopAppService } from "@main/app/app-service";
import { CoworkerDatabase } from "@main/db/database";
import {
  credentialKeySchema,
  remoteModelProviderSchema,
} from "@shared/validation";

const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "coworker-model-endpoints-"));
  temporaryPaths.push(path);
  return path;
}

function memoryCredentials() {
  const values = new Map<string, string>();
  return {
    values,
    async set(key: string, value: string) {
      values.set(key, value);
    },
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async has(key: string) {
      return values.has(key);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
}

function stubModelListing(modelIds: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ data: modelIds.map((id) => ({ id })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

describe("named OpenAI-compatible endpoints", () => {
  it("validates custom endpoint provider ids and credential keys", () => {
    expect(remoteModelProviderSchema.parse("openai-compatible:abc123")).toBe(
      "openai-compatible:abc123",
    );
    expect(remoteModelProviderSchema.parse("openrouter")).toBe("openrouter");
    expect(remoteModelProviderSchema.safeParse("openai-compatible:").success).toBe(false);
    expect(remoteModelProviderSchema.safeParse("evil:endpoint").success).toBe(false);
    expect(credentialKeySchema.parse("model:openai-compatible:abc123")).toBe(
      "model:openai-compatible:abc123",
    );
    expect(credentialKeySchema.parse("model:openai-compatible:abc123:base-url")).toBe(
      "model:openai-compatible:abc123:base-url",
    );
    expect(credentialKeySchema.safeParse("model:openai-compatible:UPPER").success).toBe(
      false,
    );
  });

  it("adds multiple named endpoints and can rename one in place", async () => {
    const root = await temporaryDirectory();
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const credentials = memoryCredentials();
    const service = new DesktopAppService({ dataPath: root, database, credentials });
    stubModelListing(["lfm-2.5", "qwen-3"]);
    try {
      const first = await service.addModelEndpoint({
        name: "LM Studio on this Mac",
        baseUrl: "http://127.0.0.1:1234/v1",
        defaultModelName: "lfm-2.5",
      });
      expect(first.provider).toMatch(/^openai-compatible:[a-z0-9]+$/);
      expect(first.configured).toBe(true);
      expect(first.defaultApplied).toBe(true);
      expect(first.models.map((model) => model.id)).toEqual(["lfm-2.5", "qwen-3"]);

      const second = await service.addModelEndpoint({
        name: "Ollama box in the garage",
        baseUrl: "http://192.168.1.20:11434/v1",
        apiKey: "garage-key",
      });
      expect(second.provider).not.toBe(first.provider);

      const endpoints = database.listModelEndpoints();
      expect(endpoints.map((endpoint) => endpoint.name)).toEqual([
        "LM Studio on this Mac",
        "Ollama box in the garage",
      ]);
      expect(credentials.values.get(`model:${second.provider}`)).toBe("garage-key");
      expect(credentials.values.get(`model:${second.provider}:base-url`)).toBe(
        "http://192.168.1.20:11434/v1",
      );

      const settings = database.getSettings();
      expect(settings.defaultModelProvider).toBe(first.provider);
      expect(settings.defaultModelName).toBe("lfm-2.5");

      await service.configureModel({
        provider: first.provider,
        endpointName: "Renamed local server",
      });
      expect(database.getModelEndpoint(first.provider)?.name).toBe("Renamed local server");
      expect(database.listModelEndpoints()).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("blocks removing an endpoint a coworker still uses, then cleans up fully", async () => {
    const root = await temporaryDirectory();
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const credentials = memoryCredentials();
    const service = new DesktopAppService({ dataPath: root, database, credentials });
    stubModelListing(["lfm-2.5"]);
    try {
      const added = await service.addModelEndpoint({
        name: "Desk server",
        baseUrl: "http://127.0.0.1:1234/v1",
        defaultModelName: "lfm-2.5",
      });
      const ava = database.createCoworker(
        {
          name: "Ava",
          role: "Analyst",
          systemPrompt: "Help.",
          modelProvider: added.provider,
          modelName: "lfm-2.5",
          enabledTools: [],
        },
        join(root, "workspaces", "ava"),
      );

      await expect(service.removeModelEndpoint(added.provider)).rejects.toThrow(
        /still used by Ava/,
      );

      database.updateCoworker(ava.id, { modelProvider: "demo", modelName: "faux-1" });
      await service.removeModelEndpoint(added.provider);
      expect(database.listModelEndpoints()).toEqual([]);
      expect(credentials.values.has(`model:${added.provider}`)).toBe(false);
      expect(credentials.values.has(`model:${added.provider}:base-url`)).toBe(false);
      const settings = database.getSettings();
      expect(settings.defaultModelProvider).toBeNull();
      expect(settings.defaultModelName).toBeNull();
    } finally {
      database.close();
    }
  });

  it("surfaces a pre-existing openai-compatible credential as a legacy endpoint", async () => {
    const root = await temporaryDirectory();
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const credentials = memoryCredentials();
    credentials.values.set("model:openai-compatible", "legacy-key");
    credentials.values.set(
      "model:openai-compatible:base-url",
      "http://127.0.0.1:8080/v1",
    );
    const service = new DesktopAppService({ dataPath: root, database, credentials });
    try {
      await service.initialize();
      const endpoints = database.listModelEndpoints();
      expect(endpoints).toHaveLength(1);
      expect(endpoints[0]).toMatchObject({
        id: "openai-compatible",
        name: "OpenAI-compatible",
        baseUrl: "http://127.0.0.1:8080/v1",
      });
      expect(service.snapshot().modelEndpoints).toHaveLength(1);
    } finally {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("OpenRouter credentials", () => {
  const routerModel = openrouterProvider().getModels()[0]!;

  function stubOpenRouter(acceptedKey: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          });
        if (new URL(String(input)).pathname !== "/api/v1/key") {
          return json({ data: [{ id: routerModel.id }] });
        }
        return new Headers(init?.headers).get("authorization") === `Bearer ${acceptedKey}`
          ? json({ data: { label: "accepted" } })
          : json({ error: { message: "Missing Authentication header", code: 401 } }, 401);
      }),
    );
  }

  it("rejects a key OpenRouter does not accept and keeps the saved one", async () => {
    const root = await temporaryDirectory();
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const credentials = memoryCredentials();
    credentials.values.set("model:openrouter", "sk-or-v1-saved");
    const service = new DesktopAppService({ dataPath: root, database, credentials });
    stubOpenRouter("sk-or-v1-saved");
    try {
      await expect(
        service.configureModel({ provider: "openrouter", apiKey: "sk-not-openrouter" }),
      ).rejects.toThrow(/OpenRouter did not accept this API key/);
      expect(credentials.values.get("model:openrouter")).toBe("sk-or-v1-saved");
    } finally {
      database.close();
    }
  });

  it("restarts coworkers on OpenRouter when its key changes, not on other saves", async () => {
    const root = await temporaryDirectory();
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const credentials = memoryCredentials();
    const service = new DesktopAppService({ dataPath: root, database, credentials });
    const routed = database.createCoworker(
      {
        name: "Ava",
        role: "Analyst",
        systemPrompt: "Help.",
        modelProvider: "openrouter",
        modelName: routerModel.id,
        enabledTools: [],
      },
      join(root, "workspaces", "ava"),
    );
    database.createCoworker(
      {
        name: "Sarah",
        role: "Sales",
        systemPrompt: "Help.",
        modelProvider: "demo",
        modelName: "faux-1",
        enabledTools: [],
      },
      join(root, "workspaces", "sarah"),
    );
    const stop = vi.spyOn(service.runtime, "stop").mockResolvedValue();
    const enqueue = vi.spyOn(service.runtime, "enqueueTask").mockImplementation(() => undefined);
    stubOpenRouter("sk-or-v1-new");
    try {
      await service.configureModel({ provider: "openrouter", apiKey: "sk-or-v1-new" });
      expect(stop.mock.calls).toEqual([[routed.id]]);
      expect(enqueue.mock.calls).toEqual([[routed.id]]);

      stop.mockClear();
      await service.configureModel({ provider: "openrouter", defaultModelName: routerModel.id });
      expect(stop).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("disconnects OpenRouter: forgets its key, restarts its coworkers and clears the default", async () => {
    const root = await temporaryDirectory();
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const credentials = memoryCredentials();
    credentials.values.set("model:openrouter", "sk-or-v1-saved");
    const service = new DesktopAppService({ dataPath: root, database, credentials });
    const routed = database.createCoworker(
      {
        name: "Ava",
        role: "Analyst",
        systemPrompt: "Help.",
        modelProvider: "openrouter",
        modelName: routerModel.id,
        enabledTools: [],
      },
      join(root, "workspaces", "ava"),
    );
    database.updateSettings({ defaultModelProvider: "openrouter", defaultModelName: routerModel.id });
    const stop = vi.spyOn(service.runtime, "stop").mockResolvedValue();
    vi.spyOn(service.runtime, "enqueueTask").mockImplementation(() => undefined);
    try {
      await service.disconnectModelProvider("openrouter");
      expect(credentials.values.has("model:openrouter")).toBe(false);
      expect(stop.mock.calls).toEqual([[routed.id]]);
      // The coworker keeps its model so reconnecting brings it straight back.
      expect(database.getCoworker(routed.id).modelProvider).toBe("openrouter");
      expect(database.getSettings()).toMatchObject({ defaultModelProvider: null, defaultModelName: null });
      expect(database.listActivity().map((item) => item.type)).toContain("model.disconnected");

      await expect(service.disconnectModelProvider("openai-compatible:desk")).rejects.toThrow(
        "Remove OpenAI-compatible endpoints instead of disconnecting them",
      );
    } finally {
      database.close();
    }
  });
});
