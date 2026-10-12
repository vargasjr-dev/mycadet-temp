import {
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

let seededRawText = "";
let mtimeSeq = 0;

function configJsonPath(): string {
  return join(process.env.CADET_WORKSPACE_DIR!, "config.json");
}

function mcpJsonPath(): string {
  return join(process.env.CADET_WORKSPACE_DIR!, "mcp.json");
}

function seedRawConfig(raw: Record<string, unknown>): void {
  seededRawText = JSON.stringify(raw);
  mkdirSync(process.env.CADET_WORKSPACE_DIR!, { recursive: true });
  writeFileSync(configJsonPath(), seededRawText);
  mtimeSeq += 1;
  const stamp = new Date(Date.now() + mtimeSeq);
  utimesSync(configJsonPath(), stamp, stamp);
}

function seedWorkspaceMcp(document: unknown): void {
  writeFileSync(mcpJsonPath(), JSON.stringify(document, null, 2) + "\n");
}

function committedRaw(): Record<string, unknown> | null {
  const text = readFileSync(configJsonPath(), "utf8");
  if (text === seededRawText) {
    return null;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

mock.module("../daemon/config-watcher.js", () => ({
  getConfigWatcher: () => ({
    suppressConfigReload: false,
    timers: { schedule: () => {} },
    updateFingerprint: () => {},
  }),
}));

mock.module("../providers/registry.js", () => ({
  clearConnectionProviderCache: () => {},
  getProvider: () => {
    throw new Error("provider registry mock not implemented");
  },
  getProviderRoutingSource: () => null,
  initializeProviders: async () => {},
  isNativeWebSearchCapableProvider: () => false,
  listProviders: () => [],
  resolveProviderFromConnection: async () => null,
  shouldUseNativeWebSearch: () => false,
}));

mock.module("../persistence/embeddings/embedding-backend.js", () => ({
  isEmbeddingDimensionAvailable: async () => true,
  EmbeddingBackendUnavailableError: class EmbeddingBackendUnavailableError extends Error {},
  SPARSE_EMBEDDING_VERSION: 4,
  clearEmbeddingBackendCache: () => {},
  embedWithBackend: async () => ({
    provider: "local",
    model: "test",
    vectors: [],
  }),
  geminiCacheExtras: () => [],
  customCacheExtras: () => [],
  durableEmbeddingCacheExtras: () => [],
  generateSparseEmbedding: () => ({ indices: [], values: [] }),
  getMemoryBackendStatus: async () => ({
    enabled: false,
    provider: null,
    model: null,
  }),
  resetLocalEmbeddingFailureState: () => {},
  resolveBackendDimension: async () => null,
  selectEmbeddingBackend: async () => null,
  selectedBackendSupportsMultimodal: async () => false,
}));

const { ROUTES } =
  await import("../runtime/routes/conversation-query-routes.js");

function findRoute(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route not found: ${operationId}`);
  }
  return route;
}

const configGetRoute = findRoute("config_get");
const configPatchRoute = findRoute("config_patch");
const configSetRoute = findRoute("config_set");

describe("MCP config secret boundary", () => {
  beforeEach(() => {
    seedRawConfig({});
    rmSync(mcpJsonPath(), { force: true });
  });

  test("config_get serves no mcp subtree — workspace mcp.json headers never reach the config wire", () => {
    seedWorkspaceMcp({
      mcpServers: {
        remote: {
          type: "streamable-http",
          url: "https://mcp.example.com",
          headers: {
            Authorization: "Bearer mcp-secret",
            "X-API-Key": "mcp-api-secret",
          },
        },
      },
    });

    const result = configGetRoute.handler({}) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain("mcp-secret");
    expect(JSON.stringify(result)).not.toContain("mcp-api-secret");
    expect(result.mcp).toBeUndefined();
  });

  test("config_get drops leftover config.json mcp so its headers cannot leak", () => {
    seedRawConfig({
      mcp: {
        servers: {
          remote: {
            transport: {
              type: "streamable-http",
              url: "https://mcp.example.com",
              headers: { Authorization: "Bearer leftover-secret" },
            },
          },
        },
      },
    });

    const result = configGetRoute.handler({}) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain("leftover-secret");
    expect(result.mcp).toBeUndefined();
  });

  test("config_get ignores workspace mcp.json even when a server is named headers", () => {
    seedWorkspaceMcp({
      mcpServers: {
        headers: {
          type: "streamable-http",
          url: "https://mcp.example.com",
        },
      },
    });

    const result = configGetRoute.handler({}) as Record<string, unknown>;

    expect(result.mcp).toBeUndefined();
  });

  test("config_get ignores workspace mcp.json env vars (the MCP API serves them)", () => {
    seedWorkspaceMcp({
      mcpServers: {
        local: {
          type: "stdio",
          command: "npx",
          env: {
            headers: "not-a-transport-header",
          },
        },
      },
    });

    const result = configGetRoute.handler({}) as Record<string, unknown>;

    expect(result.mcp).toBeUndefined();
  });

  test("config_patch strips MCP transport headers so generic writes cannot persist plaintext credentials", async () => {
    const result = await configPatchRoute.handler({
      body: {
        mcp: {
          servers: {
            remote: {
              transport: {
                type: "streamable-http",
                url: "https://mcp.example.com",
                headers: { Authorization: "Bearer mcp-secret" },
              },
            },
          },
        },
      },
    });

    // `mcp` is not an AssistantConfigSchema key: the write's schema parse
    // strips it, so the secret never reaches disk — and the response
    // echoes no such subtree either.
    expect(committedRaw()?.mcp).toBeUndefined();
    expect(result).not.toHaveProperty("mcp");
  });

  test("config_patch strips mcp so a full-config round trip cannot write it back", async () => {
    const result = await configPatchRoute.handler({
      body: {
        mcp: {
          servers: {
            headers: {
              transport: {
                type: "streamable-http",
                url: "https://mcp.example.com",
              },
            },
          },
        },
      },
    });

    expect(committedRaw()?.mcp).toBeUndefined();
    expect(result).not.toHaveProperty("mcp");
  });

  test("config_set drops MCP server writes", async () => {
    const result = await configSetRoute.handler({
      body: {
        path: "mcp.servers",
        value: {
          remote: {
            transport: {
              type: "streamable-http",
              url: "https://mcp.example.com",
            },
          },
        },
      },
    });

    expect(result).toEqual({ ok: true });
    expect(committedRaw()?.mcp).toBeUndefined();
  });

  test("config_set drops direct MCP transport header paths", async () => {
    const result = await configSetRoute.handler({
      body: {
        path: "mcp.servers.remote.transport.headers.Authorization",
        value: "Bearer mcp-secret",
      },
    });

    expect(result).toEqual({ ok: true });
    expect(committedRaw()?.mcp).toBeUndefined();
  });
});
