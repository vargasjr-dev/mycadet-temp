import { afterAll, beforeEach, expect, mock, test } from "bun:test";

// Snapshot the real modules before mocking so the module-scoped `afterAll`
// can restore them — bun runs every test file in one process with a shared
// loader, and `mock.restore()` does not undo `mock.module()`.
const realExecModule = { ...(await import("../exec")) };

/**
 * The docker sleep leg narrates its own progress: the unsupported `--wait`
 * note when asked to wait, and the containers-stopped line once the group
 * is down. The exec fake lets every inspect see a running container that
 * stops on the first poll.
 */
let inspectStatus: string;

const execMock = mock(
  async (cmd: string, args: string[] = []): Promise<void> => {
    if (cmd !== "docker") throw new Error(`unexpected command: ${cmd}`);
    void args;
  },
);
const execOutputMock = mock(async (_cmd: string, args: string[] = []) => {
  if (args[0] !== "inspect") throw new Error(`unexpected: ${args[0]}`);
  if (args[2] === "{{.State.Status}}") return inspectStatus;
  if (args[2] === "{{.State.Running}}") return "false";
  throw new Error(`unexpected inspect format: ${args[2]}`);
});

afterAll(() => {
  mock.module("../exec", () => realExecModule);
});

import type { LockfileAssistant } from "../lockfile-contract";
import { sleepDocker } from "../remotes/docker/sleep";

const entry: LockfileAssistant = {
  assistantId: "docker-1",
  cloud: "docker",
  port: 7830,
};

beforeEach(() => {
  mock.module("../exec", () => ({
    ...realExecModule,
    exec: execMock,
    execOutput: execOutputMock,
  }));
  execMock.mockReset();
  execOutputMock.mockReset();
  execOutputMock.mockImplementation(async (_cmd, args = []) => {
    if (args[0] !== "inspect") throw new Error(`unexpected: ${args[0]}`);
    if (args[2] === "{{.State.Status}}") return inspectStatus;
    if (args[2] === "{{.State.Running}}") return "false";
    throw new Error(`unexpected inspect format: ${args[2]}`);
  });
  inspectStatus = "running";
});

test("the docker leg narrates the containers-stopped line itself", async () => {
  const lines: string[] = [];
  await sleepDocker(entry, { log: (line) => lines.push(line) });

  expect(lines).toEqual(["Docker containers stopped."]);
});

test("the docker leg narrates that --wait is unsupported when asked", async () => {
  const lines: string[] = [];
  await sleepDocker(entry, {
    wait: true,
    log: (line) => lines.push(line),
  });

  expect(lines).toEqual([
    "--wait is not supported for Docker assistants yet — stopping containers now.",
    "Docker containers stopped.",
  ]);
});

test("the docker leg stays silent for headless hosts (no log)", async () => {
  await sleepDocker(entry, { wait: true });
  expect(execMock).toHaveBeenCalled();
});
