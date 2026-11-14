import { describe, expect, test } from "bun:test";

import {
  applyHatchConfig,
  buildHatchConfigValues,
  buildNestedConfig,
} from "../remotes/local/hatch-config";

describe("hatch-config", () => {
  test("buildNestedConfig only converts dot-notation values", () => {
    expect(
      buildNestedConfig({
        "llm.default.provider": "anthropic",
        "llm.default.model": "claude-sonnet-4-6",
      }),
    ).toEqual({
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      },
    });
  });

  test("buildNestedConfig preserves nested fragments like profile overrides", () => {
    expect(
      buildNestedConfig({
        "llm.activeProfile": "quality-optimized",
        "llm.profiles.quality-optimized.provider": "anthropic",
        "llm.profiles.quality-optimized.model": "claude-opus-4-7",
        "llm.profiles.quality-optimized.maxTokens": "32000",
      }),
    ).toEqual({
      llm: {
        activeProfile: "quality-optimized",
        profiles: {
          "quality-optimized": {
            provider: "anthropic",
            model: "claude-opus-4-7",
            maxTokens: "32000",
          },
        },
      },
    });
  });

  test("buildNestedConfig does not invent a mainAgent callSite for Anthropic defaults", () => {
    expect(
      buildNestedConfig({
        "llm.default.provider": "anthropic",
        "llm.default.model": "claude-opus-4-7",
        "llm.callSites.mainAgent.model": "claude-haiku-4-5-20251001",
      }),
    ).toEqual({
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-opus-4-7",
        },
        callSites: {
          mainAgent: {
            model: "claude-haiku-4-5-20251001",
          },
        },
      },
    });
  });

  test("buildHatchConfigValues adds the default hatch provider when no config exists", () => {
    expect(buildHatchConfigValues({}, "anthropic")).toEqual({
      "llm.default.provider": "anthropic",
    });
  });

  test("buildHatchConfigValues preserves explicit provider config", () => {
    expect(
      buildHatchConfigValues(
        {
          "llm.default.provider": "openai",
          "llm.default.model": "gpt-5.4",
        },
        "anthropic",
      ),
    ).toEqual({
      "llm.default.provider": "openai",
      "llm.default.model": "gpt-5.4",
    });
  });

  test("buildHatchConfigValues skips internal hatches without provider setup", () => {
    expect(buildHatchConfigValues({}, undefined)).toEqual({});
    expect(buildHatchConfigValues({}, null)).toEqual({});
  });

  test("applyHatchConfig sets each dotted path through the config API", async () => {
    const calls: { url: string; body: unknown; auth?: string }[] = [];
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
    });
    await applyHatchConfig({
      gatewayUrl: "http://localhost:4444/",
      bearerToken: "test-token",
      configValues: {
        "llm.default.model": "claude-opus-4-7",
        "llm.default.provider": "anthropic",
      },
      fetchImpl: (async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          auth: new Headers(init?.headers).get("Authorization") ?? undefined,
        });
        return response;
      }) as typeof fetch,
    });

    expect(calls.map((c) => c.url)).toEqual([
      "http://localhost:4444/v1/config/set",
      "http://localhost:4444/v1/config/set",
    ]);
    expect(calls.map((c) => c.body)).toEqual([
      { path: "llm.default.model", value: "claude-opus-4-7" },
      { path: "llm.default.provider", value: "anthropic" },
    ]);
    for (const call of calls) {
      expect(call.auth).toBe("Bearer test-token");
    }
  });

  test("applyHatchConfig is a no-op without values", async () => {
    let fetched = false;
    await applyHatchConfig({
      gatewayUrl: "http://localhost:4444",
      bearerToken: "test-token",
      configValues: {},
      fetchImpl: (async (..._args: unknown[]) => {
        fetched = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    expect(fetched).toBe(false);
  });

  test("applyHatchConfig skips with a warning when no token was leased", async () => {
    const warnings: string[] = [];
    let fetched = false;
    await applyHatchConfig({
      gatewayUrl: "http://localhost:4444",
      configValues: { "llm.default.provider": "anthropic" },
      fetchImpl: (async (..._args: unknown[]) => {
        fetched = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      log: (m) => warnings.push(m),
    });
    expect(fetched).toBe(false);
    expect(warnings.join("\n")).toContain("assistant config set");
  });

  test("applyHatchConfig keeps applying the remaining keys when one fails", async () => {
    const paths: string[] = [];
    const warnings: string[] = [];
    await applyHatchConfig({
      gatewayUrl: "http://localhost:4444",
      bearerToken: "test-token",
      configValues: {
        "llm.default.model": "gpt-5.4",
        "llm.default.provider": "openai",
      },
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        const body = JSON.parse(String(args[1]?.body)) as { path: string };
        paths.push(body.path);
        if (body.path === "llm.default.model") {
          return new Response("boom", { status: 500 });
        }
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      log: (m) => warnings.push(m),
    });

    // Both keys attempted; the failure warns and names a re-apply path.
    expect(paths).toEqual(["llm.default.model", "llm.default.provider"]);
    expect(warnings.join("\n")).toContain("llm.default.model");
    expect(warnings.join("\n")).toContain("assistant config set");
  });
});
