import { afterAll, beforeEach, describe, mock, test } from "bun:test";
import fs from "node:fs";

import type { Lockfile } from "@mycadet/local-mode/contract";

const CANONICAL_PATH = "/tmp/test-lockfile.json";
let mockLockfilePath = CANONICAL_PATH;

const realLocalMode = await import("@mycadet/local-mode");

// Passthrough the real parseLockfile, stubbing the @mycadet/local-mode
// entry above doesn't touch the /contract subpath it lives in.
const { parseLockfile } = await import("@mycadet/local-mode/contract");
mock.module("@mycadet/local-mode/contract", () => ({
  parseLockfile,
}));

// The watcher resolves the single canonical path through @mycadet/local-mode's
// ambient resolver; point it at the test's temp path through the module mock.
mock.module("@mycadet/local-mode", () => ({
  ...realLocalMode,
  resolveLockfilePath: () => mockLockfilePath,
}));

// Restore the real module once this file finishes so the stub does not leak
// into other test files in the same `bun test` run.
afterAll(() => {
  mock.module("@mycadet/local-mode", () => realLocalMode);
});

const { installLockfileWatcher, __resetForTesting } =
  await import("./lockfile-watcher");

const SAMPLE_LOCKFILE: Lockfile = {
  assistants: [
    { assistantId: "ast-1", name: "Alpha", cloud: "local", port: 7830 },
  ],
  activeAssistant: "ast-1",
};

const writeLockfile = (data: Lockfile, path = CANONICAL_PATH): void => {
  fs.writeFileSync(path, JSON.stringify(data), "utf-8");
};

const removeLockfile = (): void => {
  fs.rmSync(CANONICAL_PATH, { force: true });
};

const POLL_WINDOW_MS = 750;

const waitForPoll = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, POLL_WINDOW_MS));

beforeEach(() => {
  mockLockfilePath = CANONICAL_PATH;
  __resetForTesting();
  removeLockfile();
});

afterAll(() => {
  __resetForTesting();
  removeLockfile();
});

describe("lockfile watcher", () => {
  test("install and teardown run without listeners or a crash", async () => {
    writeLockfile(SAMPLE_LOCKFILE);
    const teardown = installLockfileWatcher();
    await waitForPoll();
    // The poll keeps running (the tray's snapshot) until teardown.
    teardown();
  });

  test("a removed lockfile polls to empty without crashing", async () => {
    writeLockfile(SAMPLE_LOCKFILE);
    const teardown = installLockfileWatcher();
    removeLockfile();
    await waitForPoll();
    teardown();
  });

  test("an unreadable lockfile produces no crash across polls", async () => {
    fs.writeFileSync(CANONICAL_PATH, "{not json", "utf-8");
    const teardown = installLockfileWatcher();
    await waitForPoll();
    teardown();
  });
});
