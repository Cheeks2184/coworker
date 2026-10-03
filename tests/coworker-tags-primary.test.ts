import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoworkerDatabase } from "@main/db/database";
import {
  allCoworkerTags,
  filterCoworkers,
  normalizeTag,
  sortCoworkers,
} from "@renderer/lib/coworker-filter";
import { createCoworkerSchema, updateCoworkerSchema } from "@shared/validation";
import type { Coworker } from "@shared/contracts";

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function openDatabase() {
  // Always a throwaway database; never a real profile directory.
  const root = await mkdtemp(join(tmpdir(), "coworker-tags-"));
  temporaryPaths.push(root);
  return { root, database: new CoworkerDatabase(join(root, "coworker.db")) };
}

function make(database: CoworkerDatabase, root: string, name: string, tags: string[] = []) {
  return database.createCoworker(
    {
      name,
      role: "General Coworker",
      systemPrompt: "Help.",
      modelProvider: "demo",
      modelName: "faux-1",
      enabledTools: [],
      tags,
    },
    join(root, name.toLowerCase()),
  );
}

describe("coworker tags and primary flag", () => {
  it("persists tags and defaults new coworkers to non-primary", async () => {
    const { root, database } = await openDatabase();
    try {
      const ava = make(database, root, "Ava", ["finance", "ops"]);
      expect(ava).toMatchObject({ tags: ["finance", "ops"], isPrimary: false, avatarImage: null });
      const updated = database.updateCoworker(ava.id, { tags: ["legal"] });
      expect(updated.tags).toEqual(["legal"]);
    } finally {
      database.close();
    }
  });

  it("keeps at most one primary coworker", async () => {
    const { root, database } = await openDatabase();
    try {
      const ava = make(database, root, "Ava");
      const bea = make(database, root, "Bea");
      database.updateCoworker(ava.id, { isPrimary: true });
      database.updateCoworker(bea.id, { isPrimary: true });
      expect(database.getCoworker(ava.id).isPrimary).toBe(false);
      expect(database.getCoworker(bea.id).isPrimary).toBe(true);
      database.updateCoworker(bea.id, { isPrimary: false });
      expect(database.listCoworkers().filter((c) => c.isPrimary)).toHaveLength(0);
    } finally {
      database.close();
    }
  });
});

describe("tag validation", () => {
  const base = {
    name: "Ava",
    role: "Ops",
    systemPrompt: "Help.",
    modelProvider: "demo",
    modelName: "x",
    enabledTools: [],
  };

  it("trims, lowercases and de-duplicates", () => {
    const parsed = createCoworkerSchema.parse({ ...base, tags: [" Finance ", "finance", "Ops"] });
    expect(parsed.tags).toEqual(["finance", "ops"]);
  });

  it("rejects too many, too long, or malformed tags", () => {
    expect(() =>
      createCoworkerSchema.parse({ ...base, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }),
    ).toThrow();
    expect(() => createCoworkerSchema.parse({ ...base, tags: ["x".repeat(25)] })).toThrow();
    expect(() => createCoworkerSchema.parse({ ...base, tags: ["<b>"] })).toThrow();
    expect(() => createCoworkerSchema.parse({ ...base, tags: [""] })).toThrow();
  });

  it("accepts isPrimary on update only", () => {
    expect(updateCoworkerSchema.parse({ isPrimary: true })).toEqual({ isPrimary: true });
  });
});

describe("avatar photo", () => {
  const tiny = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

  it("accepts small image data URLs and null to clear on update", () => {
    expect(updateCoworkerSchema.parse({ avatarImage: tiny }).avatarImage).toBe(tiny);
    expect(updateCoworkerSchema.parse({ avatarImage: null }).avatarImage).toBeNull();
  });

  it("rejects non-image, svg, oversized, and malformed payloads", () => {
    for (const bad of [
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:text/html;base64,PGI+",
      "https://example.com/a.png",
      "data:image/png;base64,not base64!",
      `data:image/png;base64,${"A".repeat(150_001)}`,
    ]) {
      expect(() => updateCoworkerSchema.parse({ avatarImage: bad })).toThrow();
    }
  });

  it("stores and clears the photo", async () => {
    const { root, database } = await openDatabase();
    try {
      const ava = make(database, root, "Ava");
      expect(database.updateCoworker(ava.id, { avatarImage: tiny }).avatarImage).toBe(tiny);
      expect(database.updateCoworker(ava.id, { avatarImage: null }).avatarImage).toBeNull();
    } finally {
      database.close();
    }
  });
});

describe("coworker filtering", () => {
  const coworker = (id: string, name: string, tags: string[], isPrimary = false): Coworker => ({
    id, name, role: `${name} role`, description: null, systemPrompt: "", modelProvider: "demo",
    modelName: "x", status: "active", runtimeStatus: "IDLE", workspacePath: "/x", enabledTools: [],
    enabledSkillIds: [], isPrimary, tags, policies: {}, sharedFolders: [], createdAt: "", updatedAt: "",
  });
  const team = [
    coworker("1", "Ava", ["finance", "ops"]),
    coworker("2", "Bea", ["legal"], true),
    coworker("3", "Cy", ["finance"]),
  ];

  it("matches text across name, role and tags", () => {
    expect(filterCoworkers(team, "bea").map((c) => c.id)).toEqual(["2"]);
    expect(filterCoworkers(team, "legal").map((c) => c.id)).toEqual(["2"]);
    expect(filterCoworkers(team, "").length).toBe(3);
  });

  it("treats #terms as tag-only and ANDs terms", () => {
    expect(filterCoworkers(team, "#finance").map((c) => c.id)).toEqual(["1", "3"]);
    expect(filterCoworkers(team, "#finance #ops").map((c) => c.id)).toEqual(["1"]);
    expect(filterCoworkers(team, "#ava")).toEqual([]);
    expect(filterCoworkers(team, "#")).toEqual([]);
  });

  it("lists tags by popularity and sorts primary first", () => {
    expect(allCoworkerTags(team)).toEqual(["finance", "legal", "ops"]);
    expect(sortCoworkers(team).map((c) => c.id)).toEqual(["2", "1", "3"]);
  });

  it("normalizes tag input", () => {
    expect(normalizeTag("  #Finance ")).toBe("finance");
  });
});
