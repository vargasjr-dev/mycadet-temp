/**
 * Tests for the `assistant ps` CLI command.
 *
 * Validates:
 *   - Calls the `ps` IPC method exactly once
 *   - Renders the daemon process tree (parent + indented children + status)
 *   - `--json` emits the raw route payload instead of the tree
 *   - IPC failures surface via exitFromIpcResult (non-zero exit)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let ipcCalls: Array<{ method: string }> = [];
let mockResponse: {
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
} = { ok: true, result: { processes: [] } };

let logLines: string[] = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string) => {
    ipcCalls.push({ method });
    return mockResponse;
  },
  exitFromIpcResult: (r: { error?: string }) => {
    process.stderr.write((r.error ?? "error") + "\n");
    process.exit(1);
  },
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: (msg: string) => logLines.push(msg),
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerPsCommand } = await import("../ps.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runPsCommand(
  args: string[] = [],
): Promise<{ stdout: string; exitCode: number }> {
  const stdoutChunks: string[] = [];
  let capturedExitCode = 0;
  let exitCalled = false;

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalExit = process.exit.bind(process);

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  (process as { exit: (code?: number) => never }).exit = ((code?: number) => {
    capturedExitCode = code ?? 0;
    exitCalled = true;
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerPsCommand(program);
    await program.parseAsync(["node", "assistant", "ps", ...args]);
  } catch (err) {
    if (err instanceof Error && !err.message.startsWith("process.exit(")) {
      // Commander parse errors; ignore
    }
  } finally {
    process.stdout.write = originalStdoutWrite;
    (process as { exit: (code?: number) => never }).exit = originalExit;
  }

  const exitCode = exitCalled ? capturedExitCode : (process.exitCode ?? 0);
  process.exitCode = 0;

  return { exitCode, stdout: stdoutChunks.join("") };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  ipcCalls = [];
  logLines = [];
  mockResponse = { ok: true, result: { processes: [] } };
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ps table", () => {
  test("shows headers, rules, tool attribution and right-aligned resource columns", async () => {
    mockResponse = {
      ok: true,
      result: {
        processes: [
          {
            name: "assistant",
            status: "running",
            origin: "workspace",
            pid: 7,
            cpuPct: 224.3,
            rssBytes: 3 * 1024 ** 3,
            children: [
              {
                name: "bash " + "x".repeat(100),
                status: "running",
                origin: "workspace",
                pid: 42,
                tool: { toolName: "bash", conversationId: "conv-123" },
                cpuPct: 0,
                rssBytes: 1024 ** 2,
                children: [
                  {
                    name: "bun test",
                    status: "running",
                    origin: "workspace",
                    pid: 43,
                    tool: { toolName: "bash", conversationId: "conv-123" },
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    await runPsCommand();
    expect(ipcCalls).toEqual([{ method: "ps" }]);
    const text = logLines.join("\n");
    for (const header of [
      "PROCESS",
      "PID",
      "SOURCE",
      "CONVERSATION",
      "CPU",
      "RAM",
    ]) {
      expect(text).toContain(header);
    }
    expect(text).not.toContain("workspace");
    expect(text).toContain("tool:bash");
    expect(text).toContain("conv-123");
    expect(text).toContain("224.3%");
    expect(text).toContain("3072.0 MiB");
    expect(text).toContain("0.0%");
    expect(logLines.filter((line) => line.startsWith("─"))).toHaveLength(2);
    const child = logLines.find((line) => line.startsWith("  bash"))!;
    expect(child.indexOf("…")).toBe(14);
    expect(child.slice(0, 30)).toHaveLength(30);
    expect(child.slice(30, 32)).toBe("  ");
    expect(
      logLines.find((line) => line.startsWith("    bun test")),
    ).toBeDefined();
    const root = logLines.find((line) => line.startsWith("assistant"))!;
    expect(root.indexOf("tool:bash")).toBe(-1);
    expect(root.indexOf("%")).toBe(child.indexOf("%"));
  });

  test("preserves plugin identity without a workspace column", async () => {
    mockResponse = {
      ok: true,
      result: {
        processes: [
          {
            name: "memory-worker",
            origin: "plugin:default-memory",
            status: "running",
          },
        ],
      },
    };
    await runPsCommand();
    expect(logLines.join("\n")).toContain("plugin:default-memory");
    expect(logLines.join("\n")).toContain("—");
  });

  test("prints a placeholder for an empty tree", async () => {
    await runPsCommand();
    expect(logLines.join("\n")).toContain("No processes reported.");
  });

  test("JSON preserves the complete route payload", async () => {
    const result = {
      processes: [{ name: "assistant", pid: 7, cpuPct: 12, rssBytes: 1024 }],
    };
    mockResponse = { ok: true, result };
    const { stdout } = await runPsCommand(["--json"]);
    expect(JSON.parse(stdout)).toEqual(result);
    expect(logLines).toEqual([]);
  });

  test("IPC failure exits nonzero", async () => {
    mockResponse = { ok: false, error: "boom", statusCode: 500 };
    expect((await runPsCommand()).exitCode).toBe(1);
  });
});
