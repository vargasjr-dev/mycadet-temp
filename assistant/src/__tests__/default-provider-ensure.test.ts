/**
 * Tests for `ensureDefaultProvider` in `workspace/default-provider-ensure.ts`.
 *
 * `hasManagedProxyPrereqs` is mocked at module scope; `bun:test` isolates
 * `mock.module` per test file.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const proxyState = { prereqs: false };

mock.module("../providers/platform-proxy/context.js", () => ({
  hasManagedProxyPrereqs: async () => proxyState.prereqs,
}));

import { credentialKey } from "../security/credential-key.js";
import { useMemorySecureKeyMap } from "./helpers/secure-keys.js";

// The REAL secure-keys module pinned to a live memory backend.
const secureKeys = useMemorySecureKeyMap();
const ANTHROPIC_KEY = credentialKey("anthropic", "api_key");

const { ensureDefaultProvider } =
  await import("../workspace/default-provider-ensure.js");
const { LLMSchema } = await import("../config/schemas/llm.js");

let workspaceDir: string;
let originalIsPlatform: string | undefined;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `cadet-default-provider-ensure-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

function llm(): Record<string, unknown> {
  return readConfig().llm as Record<string, unknown>;
}

beforeEach(() => {
  freshWorkspace();
  originalIsPlatform = process.env.IS_PLATFORM;
  delete process.env.IS_PLATFORM;
  proxyState.prereqs = false;
  secureKeys.delete(ANTHROPIC_KEY);
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
  if (originalIsPlatform === undefined) {
    delete process.env.IS_PLATFORM;
  } else {
    process.env.IS_PLATFORM = originalIsPlatform;
  }
});

describe("ensureDefaultProvider", () => {
  test("a usable blob provider is left alone", async () => {
    writeConfig({ llm: { default: { provider: "gemini" } } });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().default).toEqual({ provider: "gemini" });
  });

  test("backfills from custom-balanced provider", async () => {
    writeConfig({
      llm: {
        profiles: {
          "custom-balanced": { source: "user", provider: "openai" },
        },
      },
    });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().default).toEqual({ provider: "openai" });
  });

  test("uses custom-quality-optimized when custom-balanced lacks a provider", async () => {
    writeConfig({
      llm: {
        profiles: {
          "custom-balanced": { source: "user" },
          "custom-quality-optimized": { source: "user", provider: "fireworks" },
        },
      },
    });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().default).toEqual({ provider: "fireworks" });
  });

  test("IS_PLATFORM true resolves to cadet", async () => {
    process.env.IS_PLATFORM = "true";
    writeConfig({ llm: {} });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().default).toEqual({ provider: "cadet" });
  });

  test("a usable blob provider is trusted even on platform", async () => {
    // The old pass overrode a legacy `llm.default.provider` signal on
    // platform because the key was the storage and the blob was inert
    // leftovers. The blob is the storage now — real platform hatches either
    // write cadet or write nothing, so a usable provider is intent.
    process.env.IS_PLATFORM = "1";
    writeConfig({ llm: { default: { provider: "anthropic" } } });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().default).toEqual({ provider: "anthropic" });
  });

  test("a usable blob provider outranks the login fallback off-platform", async () => {
    proxyState.prereqs = true;
    writeConfig({ llm: { default: { provider: "openai" } } });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().default).toEqual({ provider: "openai" });
  });

  test("hasManagedProxyPrereqs true resolves to cadet when off-platform", async () => {
    proxyState.prereqs = true;
    writeConfig({ llm: {} });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().default).toEqual({ provider: "cadet" });
  });

  test("falls back to anthropic when not on platform and not logged in", async () => {
    proxyState.prereqs = false;
    writeConfig({ llm: {} });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().default).toEqual({ provider: "anthropic" });
  });

  test("a non-matrix API-key provider blob is honored", async () => {
    proxyState.prereqs = false;
    writeConfig({ llm: { default: { provider: "minimax" } } });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().default).toEqual({ provider: "minimax" });
  });

  test("a blob naming a provider that cannot back the defaults falls through", async () => {
    proxyState.prereqs = false;
    writeConfig({ llm: { default: { provider: "openai-compatible" } } });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().default).toEqual({ provider: "anthropic" });
  });

  test("an invalid retired key's bytes are retired; the blob stands", async () => {
    writeConfig({
      llm: {
        default: { provider: "gemini" },
        defaultProvider: { provider: "not-a-provider" },
      },
    });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().default).toEqual({ provider: "gemini" });
    expect(llm().defaultProvider).toBeUndefined();
  });

  test("a malformed connectionName invalidates the key, and the chain repairs", async () => {
    process.env.IS_PLATFORM = "1";
    writeConfig({
      llm: { defaultProvider: { provider: "anthropic", connectionName: "" } },
    });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().default).toEqual({ provider: "cadet" });
    expect(llm().defaultProvider).toBeUndefined();
  });

  test("a valid key's selection is stamped into the blob, pin carried", async () => {
    writeConfig({
      llm: {
        defaultProvider: {
          provider: "openai",
          connectionName: "openai-personal",
        },
      },
    });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().default).toEqual({
      provider: "openai",
      provider_connection: "openai-personal",
    });
    expect(llm().defaultProvider).toBeUndefined();
  });

  test("a valid retired key's intent overrides the blob's provider", async () => {
    process.env.IS_PLATFORM = "true";
    writeConfig({
      llm: {
        default: { provider: "gemini" },
        defaultProvider: { provider: "openai" },
      },
    });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().default).toEqual({ provider: "openai" });
    expect(llm().defaultProvider).toBeUndefined();
  });

  test("the stamp preserves the blob's other fields", async () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "x" },
        defaultProvider: { provider: "openai" },
      },
    });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().default).toEqual({ provider: "openai", model: "x" });
  });

  test("a pin for the old provider does not survive a provider change", async () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", provider_connection: "old-pin" },
        defaultProvider: { provider: "openai" },
      },
    });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().default).toEqual({ provider: "openai" });
  });

  test("is idempotent across repeated runs", async () => {
    writeConfig({ llm: { default: { provider: "gemini" } } });

    await ensureDefaultProvider(workspaceDir);
    const first = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    await ensureDefaultProvider(workspaceDir);
    const second = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    expect(second).toBe(first);
  });

  test("stamping is idempotent across repeated runs", async () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "x" },
        defaultProvider: { provider: "openai" },
      },
    });

    await ensureDefaultProvider(workspaceDir);
    const first = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    await ensureDefaultProvider(workspaceDir);
    const second = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    expect(second).toBe(first);
  });

  test("never writes a connection pin on the resolution path", async () => {
    process.env.IS_PLATFORM = "true";
    writeConfig({ llm: {} });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().default).toEqual({ provider: "cadet" });
    expect(
      (llm().default as Record<string, unknown>).provider_connection,
    ).toBeUndefined();
  });

  test("the written config round-trips through LLMSchema.parse", async () => {
    writeConfig({ llm: {} });

    await ensureDefaultProvider(workspaceDir);

    const parsed = LLMSchema.parse(llm());
    expect(parsed.default).toEqual({ provider: "anthropic" });
  });

  test("tolerates malformed config shapes without throwing", async () => {
    await expect(ensureDefaultProvider(workspaceDir)).resolves.toBeUndefined();
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);

    writeConfig({ llm: "not-an-object" });
    await expect(ensureDefaultProvider(workspaceDir)).resolves.toBeUndefined();

    writeFileSync(join(workspaceDir, "config.json"), "not valid json {{{");
    await expect(ensureDefaultProvider(workspaceDir)).resolves.toBeUndefined();

    writeFileSync(join(workspaceDir, "config.json"), JSON.stringify([1, 2]));
    await expect(ensureDefaultProvider(workspaceDir)).resolves.toBeUndefined();
  });

  describe("a bare anthropic blob is trusted as intent", () => {
    // The old pass disambiguated a bare "anthropic" via a stored API key
    // because the value could be a first-launch schema-default echo
    // masquerading as a routing choice for the retired KEY. The blob is the
    // state now — that echo routed anthropic then and routes anthropic now,
    // so there is nothing to disambiguate.
    test("with a stored key", async () => {
      secureKeys.set(ANTHROPIC_KEY, "sk-ant-test");
      proxyState.prereqs = true;
      writeConfig({ llm: { default: { provider: "anthropic" } } });

      await ensureDefaultProvider(workspaceDir);

      expect(llm().default).toEqual({ provider: "anthropic" });
    });

    test("without a stored key, logged in", async () => {
      proxyState.prereqs = true;
      writeConfig({ llm: { default: { provider: "anthropic" } } });

      await ensureDefaultProvider(workspaceDir);

      expect(llm().default).toEqual({ provider: "anthropic" });
    });

    test("without a stored key, not logged in", async () => {
      proxyState.prereqs = false;
      writeConfig({ llm: { default: { provider: "anthropic" } } });

      await ensureDefaultProvider(workspaceDir);

      expect(llm().default).toEqual({ provider: "anthropic" });
    });

    test("over a custom profile's provider", async () => {
      writeConfig({
        llm: {
          default: { provider: "anthropic" },
          profiles: {
            "custom-balanced": { source: "user", provider: "openai" },
          },
        },
      });

      await ensureDefaultProvider(workspaceDir);

      expect(llm().default).toEqual({ provider: "anthropic" });
    });
  });
});
