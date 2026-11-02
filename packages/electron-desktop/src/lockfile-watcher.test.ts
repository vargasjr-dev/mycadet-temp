import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
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

const {
  installLockfileWatcher,
  onLockfileChange,
  __resetForTesting,
} = await import("./lockfile-watcher");

const SAMPLE_LOCKFILE: Lockfile = {
  assistants: [
    { assistantId: "ast-1", name: "Alpha", cloud: "local", port: 7830 },
    { assistantId: "ast-2", name: "Beta", cloud: "local", port: 7830 },
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

describe("lockfile watcher", () => {
  test("does not fire listeners at install", () => {
    // The initial read only primes the mtime baseline so the first poll
    // doesn't report a spurious change; listeners fire on CHANGES.
    writeLockfile(SAMPLE_LOCKFILE);
    const teardown = installLockfileWatcher();

    const received: Lockfile[] = [];
    onLockfileChange((lockfile) => received.push(lockfile));

    expect(received).toHaveLength(0);

    teardown();
  });

  test("notifies listeners when the lockfile changes after the poll + debounce window", async () => {
    // GIVEN the watcher is installed on a written lockfile
    writeLockfile(SAMPLE_LOCKFILE);
    const teardown = installLockfileWatcher();

    const received: Lockfile[] = [];
    onLockfileChange((lockfile) => received.push(lockfile));

    // WHEN the lockfile is updated with a forced mtime bump (so the
    // filesystem registers a different mtime than the initial read).
    await new Promise((resolve) => setTimeout(resolve, 50));
    const updated: Lockfile = {
      assistants: [
        { assistantId: "ast-3", name: "Gamma", cloud: "local", port: 7830 },
      ],
      activeAssistant: "ast-3",
    };
    writeLockfile(updated);
    const now = new Date();
    fs.utimesSync(CANONICAL_PATH, now, new Date(now.getTime() + 1000));

    // THEN after poll + debounce the listener carries the new content
    await waitForPoll();

    expect(received).toHaveLength(1);
    expect(received[0]?.assistants[0]?.name).toBe("Gamma");
    expect(received[0]?.activeAssistant).toBe("ast-3");

    teardown();
  });


  test("a removed lockfile notifies the empty lockfile", async () => {
    // The CLI wiping the lockfile is a real state change: listeners hear
    // "empty" so the tray renders no assistants.
    writeLockfile(SAMPLE_LOCKFILE);
    const teardown = installLockfileWatcher();

    const received: Lockfile[] = [];
    onLockfileChange((lockfile) => received.push(lockfile));

    await new Promise((resolve) => setTimeout(resolve, 50));
    removeLockfile();
    await waitForPoll();

    expect(received).toHaveLength(1);
    expect(received[0]?.assistants).toHaveLength(0);
    expect(received[0]?.activeAssistant).toBeNull();

    teardown();
  });

  test("unsubscribe removes the listener", async () => {
    // GIVEN the watcher is installed with a listener
    writeLockfile(SAMPLE_LOCKFILE);
    const teardown = installLockfileWatcher();

    const listener = mock((_lockfile: Lockfile) => undefined);
    const unsub = onLockfileChange(listener);

    // WHEN the listener is unsubscribed before a change
    unsub();

    // AND the lockfile is updated
    await new Promise((resolve) => setTimeout(resolve, 50));
    removeLockfile();
    await waitForPoll();

    // THEN the listener was never called
    expect(listener).not.toHaveBeenCalled();

    teardown();
  });

  test("teardown clears timers and listeners", () => {
    writeLockfile(SAMPLE_LOCKFILE);
    const teardown = installLockfileWatcher();
    const listener = mock(() => undefined);
    onLockfileChange(listener);

    teardown();

    // Subsequent file changes don't fire the cleared listener.
    expect(listener).not.toHaveBeenCalled();
  });

  test("an unreadable lockfile produces no notification and no crash", async () => {
    // EACCES/EPERM on the stat or read is ridden out: the next poll retries.
    writeLockfile(SAMPLE_LOCKFILE);
    const teardown = installLockfileWatcher();

    const received: Lockfile[] = [];
    onLockfileChange((lockfile) => received.push(lockfile));

    const statSpy = spyOn(fs, "statSync").mockImplementation(() => {
      throw Object.assign(new Error("access denied"), { code: "EACCES" });
    });
    await waitForPoll();
    statSpy.mockRestore();

    expect(received).toHaveLength(0);

    teardown();
  });
});
