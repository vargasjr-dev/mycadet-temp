import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const WORKSPACE_DIR = process.env.CADET_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function ensureTestDir(): void {
  const dirs = [
    WORKSPACE_DIR,
    join(WORKSPACE_DIR, "data"),
    join(WORKSPACE_DIR, "data", "memory"),
    join(WORKSPACE_DIR, "data", "logs"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

afterAll(() => {
  mock.restore();
});

import { CADET_MANAGED_PROVIDER } from "../../providers/cadet-model-routing.js";
import { invalidateConfigCache } from "../loader.js";
import { LLMSchema } from "../schemas/llm.js";
import {
  seedInferenceProfiles,
  type SeedInferenceProfilesOptions,
} from "../seed-inference-profiles.js";

type RawLLM = Record<string, unknown> & {
  default?: { provider: string; provider_connection?: string };
};

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n");
}

function readLLM(): RawLLM {
  return (JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as { llm: RawLLM })
    .llm;
}

function seed(
  config: Record<string, unknown>,
  options: SeedInferenceProfilesOptions,
): RawLLM {
  writeConfig(config);
  invalidateConfigCache();
  seedInferenceProfiles(options);
  invalidateConfigCache();
  return readLLM();
}

describe("seedInferenceProfiles / llm.default", () => {
  beforeEach(() => {
    ensureTestDir();
    if (existsSync(CONFIG_PATH)) {
      rmSync(CONFIG_PATH, { force: true });
    }
    delete process.env.IS_PLATFORM;
    invalidateConfigCache();
  });

  afterEach(() => {
    delete process.env.IS_PLATFORM;
    invalidateConfigCache();
  });

  test("platform hatch writes cadet", () => {
    process.env.IS_PLATFORM = "true";
    const llm = seed({ llm: {} }, { isHatch: true });
    expect(llm.default).toEqual({ provider: "cadet" });
  });

  test("platform hatch trusts an existing usable blob provider", () => {
    // Every real platform hatch either writes cadet (no overlay provider) or
    // carries the hatch's own choice; a usable blob is never overwritten.
    process.env.IS_PLATFORM = "true";
    const llm = seed(
      { llm: { default: { provider: "anthropic" } } },
      { isHatch: true },
    );
    expect(llm.default).toEqual({ provider: "anthropic" });
  });

  test("BYOK hatch with an anthropic key writes anthropic", () => {
    const llm = seed(
      { llm: { default: { provider: "anthropic" } } },
      { isHatch: true },
    );
    expect(llm.default).toEqual({ provider: "anthropic" });
  });

  test("BYOK hatch with an openai key writes openai", () => {
    const llm = seed(
      { llm: { default: { provider: "openai" } } },
      { isHatch: true },
    );
    expect(llm.default).toEqual({ provider: "openai" });
  });

  test("BYOK hatch with a non-matrix API-key provider keeps that provider", () => {
    const llm = seed(
      { llm: { default: { provider: "together" } } },
      { isHatch: true },
    );
    expect(llm.default).toEqual({ provider: "together" });
  });

  test("BYOK hatch with a user-endpoint provider falls back to anthropic", () => {
    const llm = seed(
      { llm: { default: { provider: "openai-compatible" } } },
      { isHatch: true },
    );
    expect(llm.default).toEqual({ provider: "anthropic" });
  });

  test("BYOK hatch with a router provider (litellm) keeps that provider", () => {
    const llm = seed(
      { llm: { default: { provider: "litellm" } } },
      { isHatch: true },
    );
    expect(llm.default).toEqual({ provider: "litellm" });
  });

  test("BYOK hatch with provider ollama falls back to anthropic", () => {
    const llm = seed(
      { llm: { default: { provider: "ollama" } } },
      { isHatch: true },
    );
    expect(llm.default).toEqual({ provider: "anthropic" });
  });

  test("BYOK hatch with no provider entered falls back to anthropic", () => {
    const llm = seed({ llm: {} }, { isHatch: true });
    expect(llm.default).toEqual({ provider: "anthropic" });
  });

  test("BYOK hatch that selected a managed connection writes cadet", () => {
    // The managed-connection detection reads the active profile (a managed
    // template name), not the blob — with no blob provider the seed writes
    // the resolved decision.
    const llm = seed(
      { llm: { activeProfile: "balanced" } },
      { isHatch: true, preserveActiveProfile: true },
    );
    expect(llm.default).toEqual({ provider: "cadet" });
  });

  test("a pre-existing selection survives a platform hatch untouched", () => {
    process.env.IS_PLATFORM = "true";
    const llm = seed(
      { llm: { default: { provider: "anthropic" } } },
      { isHatch: true },
    );
    expect(llm.default).toEqual({ provider: "anthropic" });
  });

  test("a pre-existing selection survives a BYOK hatch untouched", () => {
    const llm = seed(
      { llm: { default: { provider: "anthropic" } } },
      { isHatch: true },
    );
    expect(llm.default).toEqual({ provider: "anthropic" });
  });

  test("a pre-existing selection survives a managed-connection hatch untouched", () => {
    const llm = seed(
      {
        llm: {
          default: { provider: "anthropic" },
          activeProfile: "balanced",
        },
      },
      { isHatch: true, preserveActiveProfile: true },
    );
    expect(llm.default).toEqual({ provider: "anthropic" });
  });

  test("non-hatch boot writes nothing", () => {
    const llm = seed({ llm: { default: { provider: "anthropic" } } }, {});
    expect(llm.default).toEqual({ provider: "anthropic" });
  });

  test("seeded config round-trips through LLMSchema.parse with the field intact", () => {
    const llm = seed(
      { llm: { default: { provider: "anthropic" } } },
      { isHatch: true },
    );
    const parsed = LLMSchema.parse(llm);
    expect(parsed.default).toEqual({ provider: "anthropic" });
  });

  test("no connectionName is ever written", () => {
    process.env.IS_PLATFORM = "true";
    const platformLLM = seed(
      { llm: { default: { provider: "anthropic" } } },
      { isHatch: true },
    );
    expect(platformLLM.default?.provider_connection).toBeUndefined();

    delete process.env.IS_PLATFORM;
    const byokLLM = seed(
      { llm: { default: { provider: "openai" } } },
      { isHatch: true },
    );
    expect(byokLLM.default?.provider_connection).toBeUndefined();

    const fallbackLLM = seed({ llm: {} }, { isHatch: true });
    expect(fallbackLLM.default?.provider_connection).toBeUndefined();
  });

  test("hatch with the managed provider creates no personal connection", async () => {
    const { initializeDb } = await import("../../persistence/db-init.js");
    const { getDb } = await import("../../persistence/db-connection.js");
    const { providerConnections } =
      await import("../../persistence/schema/inference.js");
    const { getConnection } =
      await import("../../providers/inference/connections.js");
    await initializeDb();
    try {
      // A Cadet Cloud hatch: the modern overlay blob names the managed
      // provider. The managed column routes through the canonical
      // platform-backed row — a `cadet-personal` connection backed by a
      // user API key must not be created.
      seed(
        { llm: { default: { provider: CADET_MANAGED_PROVIDER } } },
        { isHatch: true, db: getDb() },
      );
      expect(
        getConnection(getDb(), `${CADET_MANAGED_PROVIDER}-personal`),
      ).toBeNull();
      expect(getDb().select().from(providerConnections).all()).toEqual([]);
    } finally {
      getDb().delete(providerConnections).run();
    }
  });

  test("BYOK hatch via the modern overlay key still creates the personal connection", async () => {
    const { initializeDb } = await import("../../persistence/db-init.js");
    const { getDb } = await import("../../persistence/db-connection.js");
    const { providerConnections } =
      await import("../../persistence/schema/inference.js");
    const { getConnection } =
      await import("../../providers/inference/connections.js");
    await initializeDb();
    try {
      const llm = seed(
        { llm: { default: { provider: "anthropic" } } },
        { isHatch: true, db: getDb() },
      );
      expect(llm.default).toEqual({ provider: "anthropic" });
      const conn = getConnection(getDb(), "anthropic-personal");
      expect(conn?.name).toBe("anthropic-personal");
      expect(conn?.provider).toBe("anthropic");
    } finally {
      getDb().delete(providerConnections).run();
    }
  });
});
