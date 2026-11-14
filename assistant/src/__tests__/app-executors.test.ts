import { beforeEach, describe, expect, mock, test } from "bun:test";

type CompileResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  durationMs: number;
};

let compileResultOverride: CompileResult = {
  ok: true,
  errors: [],
  warnings: [],
  durationMs: 0,
};

mock.module("../bundler/app-compiler.js", () => ({
  compileApp: async () => compileResultOverride,
}));

beforeEach(() => {
  compileResultOverride = {
    ok: true,
    errors: [],
    warnings: [],
    durationMs: 0,
  };
});

import type { AppDefinition } from "../apps/app-store.js";
import {
  executeAppCreate,
  executeAppRefresh,
  executeAppUpdate,
} from "../tools/apps/executors.js";

// ---------------------------------------------------------------------------
// Mocked app-store module
// ---------------------------------------------------------------------------

// The executors import the app-store module directly (no injected store), so
// the tests mock the module — the same seam treatment compileApp gets above.
// Per-test state lives in these module-level bindings, reset by beforeEach.
let mockApp: AppDefinition | null = null;
let mockFiles: Record<string, string> = {};
let createdParams: Record<string, unknown> | undefined;
let updateArgs: Record<string, unknown> | undefined;
let associated: Array<{ appId: string; conversationId: string }> = [];
let addAppConversationIdThrows = false;

function setMockStore(
  app: AppDefinition,
  files: Record<string, string> = {},
): void {
  mockApp = app;
  mockFiles = files;
}

mock.module("../apps/app-store.js", () => ({
  getApp: (id: string) => (id === mockApp?.id ? mockApp : null),
  listApps: () => (mockApp ? [mockApp] : []),
  appFileExists: (_appId: string, path: string) => path in mockFiles,
  createApp: (params: {
    name: string;
    description?: string;
    icon?: string;
    schemaJson: string;
    htmlDefinition: string;
  }) => {
    createdParams = params as unknown as Record<string, unknown>;
    return mockApp!;
  },
  updateApp: (
    _id: string,
    updates: Partial<
      Pick<
        AppDefinition,
        "name" | "description" | "schemaJson" | "htmlDefinition" | "pages"
      >
    >,
  ) => {
    updateArgs = updates as Record<string, unknown>;
    return { ...mockApp!, ...updates };
  },
  deleteApp: () => {},
  writeAppFile: (_appId: string, path: string, content: string) => {
    mockFiles[path] = content;
  },
  addAppConversationId: (appId: string, conversationId: string) => {
    if (addAppConversationIdThrows) {
      throw new Error("disk gone");
    }
    associated.push({ appId, conversationId });
    return true;
  },
  // The executors resolve compile (and icon) paths through this; the mocked
  // compileApp above never touches the filesystem, so any stable dir works.
  getAppDirPath: (appId: string) => `/mock-apps/${appId}`,
}));

beforeEach(() => {
  mockApp = null;
  mockFiles = {};
  createdParams = undefined;
  updateArgs = undefined;
  associated = [];
  addAppConversationIdThrows = false;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMultifileApp(overrides?: Partial<AppDefinition>): AppDefinition {
  return {
    id: "multi-app",
    name: "Multifile App",
    schemaJson: "{}",
    htmlDefinition: "",
    formatVersion: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// executeAppCreate
// ---------------------------------------------------------------------------

describe("executeAppCreate", () => {
  test("falls back to the preview title when the name is omitted or blank", async () => {
    const app = makeMultifileApp({ name: "Coffee Tracker" });
    setMockStore(app, {});

    const result = await executeAppCreate({
      name: "   ",
      preview: { title: "Coffee Tracker" },
    });

    expect(result.isError).toBe(false);
    expect(createdParams?.name).toBe("Coffee Tracker");
  });

  test("defaults the name to 'New App' when neither name nor preview title is given", async () => {
    const app = makeMultifileApp({ name: "New App" });
    setMockStore(app, {});

    const result = await executeAppCreate(
      {} as unknown as Parameters<typeof executeAppCreate>[0],
    );

    expect(result.isError).toBe(false);
    expect(createdParams?.name).toBe("New App");
  });

  test("creates multifile app with src/ scaffold", async () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp({ name: "New App" });
    setMockStore(app, files);

    const result = await executeAppCreate({
      name: "New App",
    });

    expect(result.isError).toBe(false);
    // htmlDefinition should be empty — the real source lives under src/
    expect(createdParams?.htmlDefinition).toBe("");
    // Scaffold files should be written
    expect(files["src/index.html"]).toBeDefined();
    expect(files["src/index.html"]).toContain("<title>New App</title>");
    expect(files["src/index.html"]).toContain('<div id="app"></div>');
    expect(files["src/main.tsx"]).toBeDefined();
    expect(files["src/main.tsx"]).toContain("import { render } from 'preact'");
    expect(files["src/main.tsx"]).toContain('{"Hello, New App!"}');
    // next_steps directive must be present so the model keeps writing
    // real source files instead of treating the scaffold as done.
    const parsed = JSON.parse(result.content);
    expect(parsed.next_steps).toContain("placeholder src/main.tsx");
    expect(parsed.next_steps).toContain("app_refresh");
  });

  test("associates the new app with its conversation when a conversationId is given", async () => {
    const app = makeMultifileApp({ id: "app-xyz", name: "Assoc App" });
    setMockStore(app, {});

    const result = await executeAppCreate(
      { name: "Assoc App" },
      undefined,
      "conv-assoc-1",
    );

    expect(result.isError).toBe(false);
    expect(associated).toEqual([
      { appId: "app-xyz", conversationId: "conv-assoc-1" },
    ]);
  });

  test("a failed conversation association does not fail the create", async () => {
    const app = makeMultifileApp({ id: "app-throw", name: "Throw App" });
    setMockStore(app, {});
    addAppConversationIdThrows = true;

    const result = await executeAppCreate(
      { name: "Throw App" },
      undefined,
      "conv-assoc-2",
    );

    expect(result.isError).toBe(false);
  });

  test("skips auto_open on scaffold even when proxy resolver is available", async () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp({ name: "New App" });
    setMockStore(app, files);
    let proxyCalled = false;
    const proxyResolver = async () => {
      proxyCalled = true;
      return { content: JSON.stringify({ opened: true }), isError: false };
    };

    const result = await executeAppCreate({ name: "New App" }, proxyResolver);

    expect(result.isError).toBe(false);
    expect(proxyCalled).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.auto_opened).toBeUndefined();
    expect(parsed.next_steps).toContain("placeholder src/main.tsx");
    expect(parsed.next_steps).toContain("app_refresh");
  });

  test("omits next_steps when main.tsx was pre-written before app_create", async () => {
    // The agent's supported workflow is to write the real source files first
    // and then call app_create. In that case the placeholder directive would
    // be false and risk triggering a destructive rewrite of correct code.
    const files: Record<string, string> = {
      "src/main.tsx": "// real code from the agent",
    };
    const app = makeMultifileApp({ name: "Pre-written App" });
    setMockStore(app, files);

    const result = await executeAppCreate({ name: "Pre-written App" });

    expect(result.isError).toBe(false);
    // The pre-written file must be preserved
    expect(files["src/main.tsx"]).toBe("// real code from the agent");
    const parsed = JSON.parse(result.content);
    expect(parsed.next_steps).toBeUndefined();
  });

  test("includes next_steps when compile fails on the scaffold", async () => {
    compileResultOverride = {
      ok: false,
      errors: ["unexpected token"],
      warnings: [],
      durationMs: 3,
    };
    const files: Record<string, string> = {};
    const app = makeMultifileApp({ name: "Broken App" });
    setMockStore(app, files);

    const result = await executeAppCreate({ name: "Broken App" });

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.compile_errors).toEqual(["unexpected token"]);
    expect(parsed.next_steps).toContain("placeholder src/main.tsx");
    expect(parsed.next_steps).toContain("app_refresh");
  });

  test("omits next_steps when compile fails on pre-written files", async () => {
    compileResultOverride = {
      ok: false,
      errors: ["unexpected token"],
      warnings: [],
      durationMs: 3,
    };
    const files: Record<string, string> = {
      "src/main.tsx": "// agent's real (but broken) code",
    };
    const app = makeMultifileApp({ name: "Broken Pre-written App" });
    setMockStore(app, files);

    const result = await executeAppCreate({ name: "Broken Pre-written App" });

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.compile_errors).toEqual(["unexpected token"]);
    expect(parsed.next_steps).toBeUndefined();
  });

  test("suppresses auto_open when only scaffold exists", async () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp({ name: "New App" });
    setMockStore(app, files);
    let proxyCalledWith: Record<string, unknown> | undefined;
    const proxyResolver = async (
      toolName: string,
      input: Record<string, unknown>,
    ) => {
      proxyCalledWith = { toolName, input };
      return { content: JSON.stringify({ opened: true }), isError: false };
    };

    const result = await executeAppCreate({ name: "New App" }, proxyResolver);

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(proxyCalledWith).toBeUndefined();
    expect(parsed.auto_opened).toBeUndefined();
    expect(parsed.next_steps).toContain("placeholder src/main.tsx");
  });

  test("fires auto_open when source_files includes main.tsx", async () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp({ name: "Real App" });
    setMockStore(app, files);
    let proxyCalledWith: Record<string, unknown> | undefined;
    const proxyResolver = async (
      toolName: string,
      input: Record<string, unknown>,
    ) => {
      proxyCalledWith = { toolName, input };
      return { content: JSON.stringify({ opened: true }), isError: false };
    };

    const result = await executeAppCreate(
      {
        name: "Real App",
        source_files: {
          "src/main.tsx":
            "import { render } from 'preact';\nrender(<div>Real</div>, document.getElementById('app')!);",
          "src/styles.css": "body { margin: 0; }",
        },
      },
      proxyResolver,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(proxyCalledWith).toBeDefined();
    expect(parsed.auto_opened).toBe(true);
    expect(parsed.next_steps).toBeUndefined();
    expect(files["src/main.tsx"]).toContain("Real");
    expect(files["src/styles.css"]).toContain("margin");
  });

  test("source_files are written and prevent scaffold", async () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp({ name: "Inline App" });
    setMockStore(app, files);

    const result = await executeAppCreate({
      name: "Inline App",
      source_files: {
        "src/main.tsx": "// custom app code",
        "src/components/App.tsx": "// App component",
      },
    });

    expect(result.isError).toBe(false);
    expect(files["src/main.tsx"]).toBe("// custom app code");
    expect(files["src/components/App.tsx"]).toBe("// App component");
    expect(files["src/index.html"]).toBeDefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.next_steps).toBeUndefined();
  });

  test("rejects retired html shortcut", async () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp({ name: "Custom App" });
    setMockStore(app, files);

    const result = await executeAppCreate({
      name: "Custom App",
      html: "<!DOCTYPE html><html><body></body></html>",
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("app_create no longer accepts html");
    expect(files["src/index.html"]).toBeUndefined();
    expect(files["src/main.tsx"]).toBeUndefined();
  });

  test("rejects retired pages shortcut", async () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp({ name: "Custom App" });
    setMockStore(app, files);

    const result = await executeAppCreate({
      name: "Custom App",
      pages: {
        "settings.html": "<!DOCTYPE html><html><body></body></html>",
      },
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("app_create no longer accepts pages");
    expect(files["src/index.html"]).toBeUndefined();
    expect(files["src/main.tsx"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// executeAppRefresh
// ---------------------------------------------------------------------------

describe("executeAppRefresh", () => {
  test("multifile app: compiles src/ and returns result", async () => {
    const app = makeMultifileApp();
    setMockStore(app);

    const result = await executeAppRefresh({ app_id: app.id });

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.refreshed).toBe(true);
    expect(parsed.appId).toBe(app.id);
    expect(parsed.compiled).toBe(true);
    expect(parsed.compile_duration_ms).toBeDefined();
  });

  test("returns error for unknown app", async () => {
    const app = makeMultifileApp();
    setMockStore(app);

    const result = await executeAppRefresh({ app_id: "nonexistent" });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// executeAppUpdate
// ---------------------------------------------------------------------------

describe("executeAppUpdate", () => {
  test("updates metadata and recompiles a multifile app", async () => {
    const app = makeMultifileApp({ name: "Old", description: "old desc" });
    setMockStore(app);

    const result = await executeAppUpdate({
      app_id: app.id,
      name: "New Name",
      description: "new desc",
    });

    expect(result.isError).toBe(false);
    expect(updateArgs).toEqual({ name: "New Name", description: "new desc" });
    const parsed = JSON.parse(result.content);
    expect(parsed.updated).toBe(true);
    expect(parsed.name).toBe("New Name");
    expect(parsed.description).toBe("new desc");
    expect(parsed.compiled).toBe(true);
  });

  test("writes source_files before recompiling", async () => {
    const files: Record<string, string> = {};
    const app = makeMultifileApp();
    setMockStore(app, files);

    const result = await executeAppUpdate({
      app_id: app.id,
      source_files: { "src/App.tsx": "// new code" },
    });

    expect(result.isError).toBe(false);
    expect(files["src/App.tsx"]).toBe("// new code");
    expect(JSON.parse(result.content).compiled).toBe(true);
  });

  test("returns error for unknown app", async () => {
    setMockStore(makeMultifileApp());

    const result = await executeAppUpdate({ app_id: "nope" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("not found");
  });

  test("rejects invalid source_files", async () => {
    const app = makeMultifileApp();
    setMockStore(app);

    const result = await executeAppUpdate({
      app_id: app.id,
      source_files: { "src/App.tsx": 123 as unknown as string },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("must be a string");
  });
});
