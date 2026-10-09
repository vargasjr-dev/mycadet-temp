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

import { z } from "zod";

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

import { CADET_MANAGED_CONNECTION_NAME } from "../../providers/cadet-model-routing.js";
import {
  DefaultProviderSelectionSchema,
  resolveDefaultConnectionName,
  setDefaultProvider,
} from "../default-provider.js";
import { invalidateConfigCache, loadRawConfig } from "../loader.js";
import { getSchemaAtPath } from "../schema-utils.js";
import { isDefaultProviderChoice, LLMSchema } from "../schemas/llm.js";

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

describe("LLMSchema.default (the base blob)", () => {
  test("accepts a bare provider", () => {
    expect(() =>
      LLMSchema.parse({ default: { provider: "anthropic" } }),
    ).not.toThrow();
  });

  test("accepts a provider pinned to a connection", () => {
    const parsed = LLMSchema.parse({
      default: { provider: "cadet", provider_connection: "x" },
    });
    expect(parsed.default).toEqual({
      provider: "cadet",
      provider_connection: "x",
    });
  });

  // The strict write-side wire contract; the stored blob tolerates more.
  test("the selection schema rejects an unknown provider", () => {
    expect(() =>
      DefaultProviderSelectionSchema.parse({ provider: "not-a-provider" }),
    ).toThrow();
  });

  test("the selection schema rejects a structured-decision catalog provider", () => {
    expect(() =>
      DefaultProviderSelectionSchema.parse({ provider: "typesafe" }),
    ).toThrow();
  });

  test("the selection schema rejects an empty connectionName", () => {
    expect(() =>
      DefaultProviderSelectionSchema.parse({
        provider: "anthropic",
        connectionName: "",
      }),
    ).toThrow();
  });

  test("the selection schema rejects a missing provider", () => {
    expect(() =>
      DefaultProviderSelectionSchema.parse({ connectionName: "x" }),
    ).toThrow();
  });

  test("existing configs without the field still parse", () => {
    const parsed = LLMSchema.parse({});
    expect(parsed.default).toBeUndefined();
  });

  // The blob is a partial fragment with no `.catch`: a provider with no
  // matrix column stays on disk (stripping it would drop the blob's other
  // fields), and the READ clamps it to null — resolution treats that as the
  // managed column.
  test("a blob whose provider has no matrix column survives parse and clamps", () => {
    const parsed = LLMSchema.parse({
      default: { provider: "openai-compatible", model: "gpt-x" },
    });
    expect(parsed.default).toEqual({
      provider: "openai-compatible",
      model: "gpt-x",
    });
    const provider = parsed.default?.provider;
    expect(provider != null && isDefaultProviderChoice(provider)).toBe(false);
  });

  test("a non-object blob fails the parse (the loader's leaf recovery strips it)", () => {
    expect(LLMSchema.safeParse({ default: "anthropic" }).success).toBe(false);
  });

  // The config-schema API must see through the optional wrapper to the
  // object shape.
  test("schema introspection reaches the object shape and provider field", () => {
    const atField = getSchemaAtPath(LLMSchema, "default");
    expect(atField).not.toBeNull();
    const atProvider = getSchemaAtPath(LLMSchema, "default.provider");
    expect(atProvider).not.toBeNull();
    // The blob's provider is the loose provider set on purpose (stripping a
    // non-choice provider would drop the blob's other fields); the READ
    // clamps it via isDefaultProviderChoice.
    expect(atProvider?.safeParse("anthropic").success).toBe(true);
    expect(atProvider?.safeParse("openai-compatible").success).toBe(true);
    expect(atProvider?.safeParse("").success).toBe(false);
  });

  test("JSON Schema emission includes the field's object shape", () => {
    // Same options `handleGetConfigSchema` uses.
    const json = z.toJSONSchema(LLMSchema, {
      unrepresentable: "any",
      io: "input",
    }) as {
      properties?: Record<string, { properties?: Record<string, unknown> }>;
    };
    const field = json.properties?.default;
    expect(field?.properties?.provider).toBeDefined();
  });
});

describe("resolveDefaultConnectionName", () => {
  test("an explicit pin wins", () => {
    expect(
      resolveDefaultConnectionName({
        provider: "anthropic",
        connectionName: "my-connection",
      }),
    ).toBe("my-connection");
  });

  test("cadet resolves to the managed connection name", () => {
    expect(resolveDefaultConnectionName({ provider: "cadet" })).toBe(
      CADET_MANAGED_CONNECTION_NAME,
    );
  });

  test("chatgpt resolves to the canonical subscription connection name", () => {
    expect(resolveDefaultConnectionName({ provider: "chatgpt" })).toBe(
      "chatgpt-subscription",
    );
  });

  test("every other provider resolves to its personal connection", () => {
    expect(resolveDefaultConnectionName({ provider: "anthropic" })).toBe(
      "anthropic-personal",
    );
    expect(resolveDefaultConnectionName({ provider: "openai" })).toBe(
      "openai-personal",
    );
    expect(resolveDefaultConnectionName({ provider: "gemini" })).toBe(
      "gemini-personal",
    );
    expect(resolveDefaultConnectionName({ provider: "fireworks" })).toBe(
      "fireworks-personal",
    );
    expect(resolveDefaultConnectionName({ provider: "openrouter" })).toBe(
      "openrouter-personal",
    );
  });

  test("an explicit pin wins even for cadet", () => {
    expect(
      resolveDefaultConnectionName({
        provider: "cadet",
        connectionName: "pinned",
      }),
    ).toBe("pinned");
  });
});

describe("setDefaultProvider", () => {
  beforeEach(() => {
    ensureTestDir();
    if (existsSync(CONFIG_PATH)) {
      rmSync(CONFIG_PATH, { force: true });
    }
    invalidateConfigCache();
  });

  afterEach(() => {
    invalidateConfigCache();
  });

  test("set round-trips through the raw config", () => {
    setDefaultProvider({ provider: "openai", connectionName: "openai-work" });

    const raw = loadRawConfig();
    const llm = raw.llm as Record<string, unknown>;
    expect(llm.default).toEqual({
      provider: "openai",
      provider_connection: "openai-work",
    });
  });

  test("setDefaultProvider validates the provider before writing", () => {
    expect(() =>
      setDefaultProvider({
        provider: "not-a-provider",
      }),
    ).toThrow();
    expect(existsSync(CONFIG_PATH)).toBe(false);
  });

  test("setting without a connection pin replaces any stored pin", () => {
    setDefaultProvider({ provider: "openai", connectionName: "openai-work" });
    setDefaultProvider({ provider: "openai" });

    const blob = (loadRawConfig().llm as Record<string, unknown>)
      .default as Record<string, unknown>;
    expect(blob).toEqual({ provider: "openai" });
  });

  test("setDefaultProvider preserves unrelated blob fields", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        { llm: { default: { provider: "anthropic", model: "x" } } },
        null,
        2,
      ) + "\n",
    );
    invalidateConfigCache();

    setDefaultProvider({ provider: "openai" });

    const blob = (loadRawConfig().llm as Record<string, unknown>)
      .default as Record<string, unknown>;
    expect(blob).toEqual({ provider: "openai", model: "x" });
  });

  test("writes invalidate the config cache so getConfigReadOnly sees the new value", () => {
    setDefaultProvider({ provider: "fireworks" });
    const after = readConfig();
    expect((after.llm as Record<string, unknown>).default).toEqual({
      provider: "fireworks",
    });
  });
});
