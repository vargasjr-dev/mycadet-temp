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
  defaultProvider?: { provider: string; connectionName?: string };
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

describe("seedInferenceProfiles / llm.defaultProvider", () => {
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
    const llm = seed(
      { llm: {} },
      { isHatch: true },
    );
    expect(llm.defaultProvider).toEqual({ provider: "cadet" });
  });

  test("BYOK hatch with no provider entered falls back to anthropic", () => {
    const llm = seed({ llm: {} }, { isHatch: true });
    expect(llm.defaultProvider).toEqual({ provider: "anthropic" });
  });

  test("BYOK hatch that selected a managed connection writes cadet", () => {
    const llm = seed(
      {
        llm: {
          activeProfile: "balanced",
        },
      },
      { isHatch: true, preserveActiveProfile: true },
    );
    expect(llm.defaultProvider).toEqual({ provider: "cadet" });
  });

  test("a pre-existing defaultProvider survives a platform hatch untouched", () => {
    process.env.IS_PLATFORM = "true";
    const llm = seed(
      {
        llm: {
          defaultProvider: { provider: "openai" },
        },
      },
      { isHatch: true },
    );
    expect(llm.defaultProvider).toEqual({ provider: "openai" });
  });

  test("a pre-existing defaultProvider survives a BYOK hatch untouched", () => {
    const llm = seed(
      {
        llm: {
          defaultProvider: { provider: "openai" },
        },
      },
      { isHatch: true },
    );
    expect(llm.defaultProvider).toEqual({ provider: "openai" });
  });

  test("a pre-existing defaultProvider survives a managed-connection hatch untouched", () => {
    const llm = seed(
      {
        llm: {
          activeProfile: "balanced",
          defaultProvider: { provider: "openai" },
        },
      },
      { isHatch: true, preserveActiveProfile: true },
    );
    expect(llm.defaultProvider).toEqual({ provider: "openai" });
  });

  test("non-hatch boot writes nothing", () => {
    const llm = seed({ llm: {} }, {});
    expect(llm.defaultProvider).toBeUndefined();
  });

  test("seeded config round-trips through LLMSchema.parse with the field intact", () => {
    const llm = seed(
      { llm: {} },
      { isHatch: true },
    );
    const parsed = LLMSchema.parse(llm);
    expect(parsed.defaultProvider).toEqual({ provider: "anthropic" });
  });

  test("no connectionName is ever written", () => {
    process.env.IS_PLATFORM = "true";
    const platformLLM = seed(
      { llm: {} },
      { isHatch: true },
    );
    expect(platformLLM.defaultProvider?.connectionName).toBeUndefined();

    delete process.env.IS_PLATFORM;
    const byokLLM = seed(
      { llm: {} },
      { isHatch: true },
    );
    expect(byokLLM.defaultProvider?.connectionName).toBeUndefined();

    const fallbackLLM = seed({ llm: {} }, { isHatch: true });
    expect(fallbackLLM.defaultProvider?.connectionName).toBeUndefined();
  });

  test("hatch with the managed provider creates no personal connection", async () => {
    const { initializeDb } = await import("../../persistence/db-init.js");
    const { getDb } = await import("../../persistence/db-connection.js");
    const { providerConnections } = await import(
      "../../persistence/schema/inference.js"
    );
    const { getConnection } = await import(
      "../../providers/inference/connections.js"
    );
    await initializeDb();
    try {
      // A Cadet Cloud hatch: the modern overlay key names the managed
      // provider. The managed column routes through the canonical
      // platform-backed row — a `cadet-personal` connection backed by a
      // user API key must not be created.
      seed(
        { llm: { defaultProvider: { provider: CADET_MANAGED_PROVIDER } } },
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
    const { providerConnections } = await import(
      "../../persistence/schema/inference.js"
    );
    const { getConnection } = await import(
      "../../providers/inference/connections.js"
    );
    await initializeDb();
    try {
      const llm = seed(
        { llm: { defaultProvider: { provider: "anthropic" } } },
        { isHatch: true, db: getDb() },
      );
      expect(llm.defaultProvider).toEqual({ provider: "anthropic" });
      const conn = getConnection(getDb(), "anthropic-personal");
      expect(conn?.name).toBe("anthropic-personal");
      expect(conn?.provider).toBe("anthropic");
    } finally {
      getDb().delete(providerConnections).run();
    }
  });
});
