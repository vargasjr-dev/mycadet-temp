import * as realChildProcess from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";
import type { WakeOptions } from "../../runtime/agent-wake.js";
import { setBroadcastOverrideForTesting } from "../../runtime/assistant-event-hub.js";
import { SHELL_DID_NOT_START_MESSAGE } from "../shared/shell-output.js";
import type { ToolContext } from "../types.js";

const originalSpawn = realChildProcess.spawn;

type SpawnImpl = (
  ...args: Parameters<typeof realChildProcess.spawn>
) => ReturnType<typeof realChildProcess.spawn>;

const spawnCalls: {
  command: string;
  args: unknown;
  options: realChildProcess.SpawnOptions;
}[] = [];

let spawnImpl: SpawnImpl = originalSpawn;

const spawnSpy = mock((...args: Parameters<typeof realChildProcess.spawn>) => {
  spawnCalls.push({
    command: args[0],
    args: args[1],
    options: args[2] ?? {},
  });
  return spawnImpl(...args);
});

mock.module("node:child_process", () => ({
  ...realChildProcess,
  spawn: spawnSpy,
}));

setConfig("timeouts", { shellDefaultTimeoutSec: 30, shellMaxTimeoutSec: 60 });

setBroadcastOverrideForTesting(() => {});

const realWake = await import("../../runtime/agent-wake.js");
const wakeCalls: WakeOptions[] = [];
mock.module("../../runtime/agent-wake.js", () => ({
  ...realWake,
  wakeAgentForOpportunity: async (opts: WakeOptions) => {
    wakeCalls.push(opts);
    return {};
  },
}));

const { shellTool } = await import("./shell.js");

function makeContext(workingDir: string): ToolContext {
  return {
    workingDir,
    conversationId: "conv-xyz",
    trustClass: "guardian",
  };
}

function fakeChild(): realChildProcess.ChildProcess {
  const child = new realChildProcess.ChildProcess();
  Object.defineProperties(child, {
    stdout: { value: new PassThrough() },
    stderr: { value: new PassThrough() },
  });
  child.kill = () => true;
  return child;
}

function closeWithoutStart(): ReturnType<typeof realChildProcess.spawn> {
  const child = fakeChild();
  queueMicrotask(() => {
    child.emit("close", 0, null);
  });
  return child;
}

function spawnError(
  err: NodeJS.ErrnoException,
): ReturnType<typeof realChildProcess.spawn> {
  const child = fakeChild();
  queueMicrotask(() => {
    child.emit("error", err);
  });
  return child;
}

describe("bash launch failures are not success", () => {
  let workingDir = "";

  beforeEach(() => {
    spawnCalls.length = 0;
    wakeCalls.length = 0;
    spawnImpl = originalSpawn;
    workingDir = mkdtempSync(join(tmpdir(), "bash-launch-"));
  });

  afterEach(() => {
    spawnImpl = originalSpawn;
    rmSync(workingDir, { recursive: true, force: true });
  });

  test("a close with exit 0 and no process start is an error, not command_completed", async () => {
    spawnImpl = () => closeWithoutStart();
    const proof = join(workingDir, "proof.txt");

    const result = await shellTool.execute(
      {
        command: "printf ran > proof.txt",
        activity: "test",
      },
      makeContext(workingDir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe(SHELL_DID_NOT_START_MESSAGE);
    expect(result.content).not.toContain("<command_completed />");
    expect(existsSync(proof)).toBe(false);
    expect(spawnCalls).toHaveLength(1);
  });

  test("a failed spawn of the shell is an error", async () => {
    spawnImpl = () => {
      const err: NodeJS.ErrnoException = new Error(
        "spawn powershell.exe ENOENT",
      );
      err.code = "ENOENT";
      return spawnError(err);
    };

    const result = await shellTool.execute(
      {
        command: "assistant browser --help",
        activity: "test",
      },
      makeContext(workingDir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error spawning command");
    expect(result.content).toContain("The command was not found");
    expect(result.content).not.toContain("<command_completed />");
    expect(existsSync(join(workingDir, "help.txt"))).toBe(false);
  });

  for (const cronRunId of [undefined, null, "cron-run-123"]) {
    test(`preserves originating schedule ${String(cronRunId)} on background spawn error`, async () => {
      const child = fakeChild();
      spawnImpl = () => child;
      const context = { ...makeContext(workingDir), cronRunId };
      await shellTool.execute(
        { command: "echo hello", activity: "test", background: true },
        context,
      );
      context.cronRunId = "cron-run-later";
      child.emit("error", new Error("spawn ENOENT"));
      child.emit("close", null, null);

      expect(wakeCalls).toHaveLength(1);
      expect(wakeCalls[0]!.cronRunId).toBe(cronRunId ?? undefined);
      expect(wakeCalls[0]!.backgroundToolCompletion?.status).toBe("failed");
    });
  }
});
