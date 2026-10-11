import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { AGENT_PLUGINS_MCP_SCHEMA_URL } from "../spec-schema.js";
import {
  loadWorkspaceMcpConfig,
  readWorkspaceMcpFile,
  saveWorkspaceMcpConfig,
} from "../workspace-mcp-config.js";

function mcpPath(): string {
  return join(process.env.CADET_WORKSPACE_DIR!, "mcp.json");
}

describe("workspace mcp.json", () => {
  beforeEach(() => {
    mkdirSync(process.env.CADET_WORKSPACE_DIR!, { recursive: true });
    rmSync(mcpPath(), { force: true });
  });

  test("missing file is an empty server map", () => {
    expect(loadWorkspaceMcpConfig()).toEqual({ servers: {} });
    expect(readWorkspaceMcpFile().fileState).toBe("missing");
  });

  test("round-trips a spec document without wrapping transport", () => {
    saveWorkspaceMcpConfig({
      servers: {
        remote: {
          transport: {
            type: "streamable-http",
            url: "https://example.com/mcp",
          },
        },
        local: {
          transport: {
            type: "stdio",
            command: "npx",
            args: ["-y", "srv"],
          },
        },
      },
    });

    expect(JSON.parse(readFileSync(mcpPath(), "utf8"))).toEqual({
      $schema: AGENT_PLUGINS_MCP_SCHEMA_URL,
      mcpServers: {
        remote: {
          type: "streamable-http",
          url: "https://example.com/mcp",
        },
        local: {
          type: "stdio",
          command: "npx",
          args: ["-y", "srv"],
        },
      },
    });
    expect(loadWorkspaceMcpConfig()).toEqual({
      servers: {
        remote: {
          transport: {
            type: "streamable-http",
            url: "https://example.com/mcp",
          },
        },
        local: {
          transport: {
            type: "stdio",
            command: "npx",
            args: ["-y", "srv"],
          },
        },
      },
    });
  });

  test("does not persist transport headers", () => {
    saveWorkspaceMcpConfig({
      servers: {
        remote: {
          transport: {
            type: "streamable-http",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer secret" },
          },
        },
      },
    });

    const onDisk = readFileSync(mcpPath(), "utf8");
    expect(onDisk).not.toContain("secret");
    expect(loadWorkspaceMcpConfig().servers.remote?.transport).toEqual({
      type: "streamable-http",
      url: "https://example.com/mcp",
    });
  });

  test("invalid file does not throw on read and refuses a later write", () => {
    mkdirSync(process.env.CADET_WORKSPACE_DIR!, { recursive: true });
    writeFileSync(mcpPath(), "{ not json");

    expect(loadWorkspaceMcpConfig()).toEqual({ servers: {} });
    expect(readWorkspaceMcpFile().fileState).toBe("invalid");
    expect(() => saveWorkspaceMcpConfig({ servers: {} })).toThrow(
      /invalid JSON/,
    );
  });

  test("raw load passes hand-authored headers through — serving layers strip them", () => {
    mkdirSync(process.env.CADET_WORKSPACE_DIR!, { recursive: true });
    writeFileSync(
      mcpPath(),
      JSON.stringify({
        $schema: AGENT_PLUGINS_MCP_SCHEMA_URL,
        mcpServers: {
          remote: {
            type: "streamable-http",
            url: "https://example.com/mcp",
            headers: { authorization: "Bearer secret" },
          },
        },
      }),
    );

    // The module API returns the file's content unfiltered: a hand-authored
    // mcp.json may carry headers, so anything serving this raw — config
    // responses, exports — would leak secrets. The MCP list handler is the
    // serving layer and strips them.
    expect(loadWorkspaceMcpConfig().servers.remote?.transport).toEqual({
      type: "streamable-http",
      url: "https://example.com/mcp",
      headers: { authorization: "Bearer secret" },
    });
  });
});
