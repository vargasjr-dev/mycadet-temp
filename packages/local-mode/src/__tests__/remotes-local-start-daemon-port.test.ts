import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bun shares one loader across test files and `mock.restore()` does not
// undo `mock.module()`, so the real module is restored in `afterAll`.
const realProcess = { ...(await import("../process")) };

const resolveProcessStateMock = mock<typeof realProcess.resolveProcessState>(
  async () => ({ status: "healthy", pid: 4242 }),
);

mock.module("../process", () => ({
  ...realProcess,
  resolveProcessState: resolveProcessStateMock,
}));

afterAll(() => {
  mock.module("../process", () => realProcess);
});

import { startLocalDaemon } from "../remotes/local/common";

test("startLocalDaemon health-checks the instance's own daemon port", async () => {
  spyOn(console, "log").mockImplementation(() => {});

  await startLocalDaemon(false, {
    assistantId: "local-assistant",
    cloud: "local",
    instanceDir: mkdtempSync(join(tmpdir(), "cadet-start-daemon-port-")),
    daemonPort: 7900,
    port: 7830,
  });

  expect(resolveProcessStateMock.mock.calls[0]?.[1]).toBe(7900);
});
