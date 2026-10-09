import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, mock, test } from "bun:test";

import { initializeDb } from "../persistence/db-init.js";
import type { ToolContext } from "../tools/types.js";
import { seedApp } from "./helpers/seed-app.js";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "conv-1",
    trustClass: "guardian",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The skill scripts pass the REAL app-store module to the executors, so the
// store runs on the per-process test workspace. `app-1` is re-seeded before
// each test (the app-delete test really deletes it); per-conversation lookups
// go through real rows seeded with conversationIds.
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initializeDb();
});

// Mock compileApp for multifile scaffold path
mock.module("../bundler/app-compiler.js", () => ({
  compileApp: async () => ({
    ok: true,
    errors: [],
    warnings: [],
    durationMs: 0,
  }),
}));

// ---------------------------------------------------------------------------
// Import skill scripts (after mocking)
// ---------------------------------------------------------------------------

import { beforeAll, beforeEach } from "bun:test";

import * as appCreateScript from "../config/bundled-skills/app-builder/tools/app-create.js";
import * as appDeleteScript from "../config/bundled-skills/app-builder/tools/app-delete.js";
import * as appOpenScript from "../config/bundled-skills/app-builder/tools/app-open.js";
import * as appRefreshScript from "../config/bundled-skills/app-builder/tools/app-refresh.js";
import * as appUpdateScript from "../config/bundled-skills/app-builder/tools/app-update.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("app-builder skill tool scripts", () => {
  beforeEach(() => {
    seedApp({ id: "app-1", name: "Test App", description: "A test app" });
  });

  // ---- app-create --------------------------------------------------------

  describe("app-create", () => {
    test("exports a run function", () => {
      expect(typeof appCreateScript.run).toBe("function");
    });

    test("delegates to executeAppCreate and returns result", async () => {
      const result = await appCreateScript.run(
        { name: "My App" },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.name).toBe("My App");
    });

    test("passes proxyToolResolver from context for auto-open", async () => {
      const proxy: ToolContext["proxyToolResolver"] = async () => ({
        content: "opened",
        isError: false,
      });
      const result = await appCreateScript.run(
        {
          name: "Auto App",
          source_files: { "src/main.tsx": "// real code" },
        },
        makeContext({ proxyToolResolver: proxy }),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.auto_opened).toBe(true);
      expect(parsed.open_result).toBe("opened");
    });

    test("handles missing proxyToolResolver gracefully", async () => {
      const result = await appCreateScript.run(
        { name: "No Proxy" },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      // No auto-open fields when resolver is absent
      expect(parsed.auto_opened).toBeUndefined();
    });
  });

  // ---- app-delete --------------------------------------------------------

  describe("app-delete", () => {
    test("exports a run function", () => {
      expect(typeof appDeleteScript.run).toBe("function");
    });

    test("delegates to executeAppDelete and returns result", async () => {
      const result = await appDeleteScript.run(
        { app_id: "app-1" },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.deleted).toBe(true);
      expect(parsed.appId).toBe("app-1");
    });
  });

  // ---- app-refresh -------------------------------------------------------

  describe("app-refresh", () => {
    test("exports a run function", () => {
      expect(typeof appRefreshScript.run).toBe("function");
    });

    test("delegates to executeAppRefresh and returns result", async () => {
      const result = await appRefreshScript.run(
        { app_id: "app-1" },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.refreshed).toBe(true);
      expect(parsed.appId).toBe("app-1");
    });
  });

  // ---- app-update --------------------------------------------------------

  describe("app-update", () => {
    test("exports a run function", () => {
      expect(typeof appUpdateScript.run).toBe("function");
    });

    test("delegates to executeAppUpdate and returns result", async () => {
      const result = await appUpdateScript.run(
        { app_id: "app-1", name: "Renamed" },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.updated).toBe(true);
      expect(parsed.appId).toBe("app-1");
      expect(parsed.name).toBe("Renamed");
    });
  });

  // ---- app-open ----------------------------------------------------------

  describe("app-open", () => {
    test("exports a run function", () => {
      expect(typeof appOpenScript.run).toBe("function");
    });

    test("resolves the active app when app_id is omitted", async () => {
      seedApp({
        id: "active-app",
        name: "active-app",
        conversationIds: ["conv-open-1"],
      });
      const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
      const proxy: ToolContext["proxyToolResolver"] = async (name, input) => {
        calls.push({ name, input });
        return { content: "opened", isError: false };
      };

      const result = await appOpenScript.run(
        {},
        makeContext({ conversationId: "conv-open-1", proxyToolResolver: proxy }),
      );

      expect(result.isError).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("app_open");
      expect(calls[0].input.app_id).toBe("active-app");
    });

    test("forwards an explicit app_id unchanged", async () => {
      const calls: Array<{ input: Record<string, unknown> }> = [];
      const proxy: ToolContext["proxyToolResolver"] = async (_name, input) => {
        calls.push({ input });
        return { content: "opened", isError: false };
      };

      await appOpenScript.run(
        { app_id: "explicit-app", open_mode: "workspace" },
        makeContext({ proxyToolResolver: proxy }),
      );

      expect(calls[0].input.app_id).toBe("explicit-app");
    });

    test("errors when app_id is omitted and no active app exists", async () => {
      const proxy: ToolContext["proxyToolResolver"] = async () => ({
        content: "opened",
        isError: false,
      });

      const result = await appOpenScript.run(
        {},
        makeContext({ conversationId: "conv-open-none", proxyToolResolver: proxy }),
      );

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toContain("app_create");
    });

    test("errors when no client proxy resolver is available", async () => {
      seedApp({
        id: "active-app",
        name: "active-app",
        conversationIds: ["conv-open-noproxy"],
      });
      const result = await appOpenScript.run(
        { app_id: "app-1" },
        makeContext({ conversationId: "conv-open-noproxy" }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("connected client");
    });
  });
});

// ---------------------------------------------------------------------------
// Manifest guard: app_id must stay optional for the tools whose executor falls
// back to the conversation's active app, or schema validation rejects the
// omission before resolveAppId can run.
// ---------------------------------------------------------------------------

describe("app-builder TOOLS.json app_id optionality", () => {
  const manifest = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../config/bundled-skills/app-builder/TOOLS.json",
      ),
      "utf8",
    ),
  ) as {
    tools: Array<{ name: string; input_schema: { required?: string[] } }>;
  };

  function requiredFor(name: string): string[] {
    const tool = manifest.tools.find((t) => t.name === name);
    if (!tool) {
      throw new Error(`tool ${name} not found in manifest`);
    }
    return tool.input_schema.required ?? [];
  }

  for (const name of [
    "app_open",
    "app_update",
    "app_refresh",
    "app_generate_icon",
  ]) {
    test(`${name} does not require app_id`, () => {
      expect(requiredFor(name)).not.toContain("app_id");
    });
  }

  test("app_delete still requires app_id (no active-app fallback)", () => {
    expect(requiredFor("app_delete")).toContain("app_id");
  });
});
