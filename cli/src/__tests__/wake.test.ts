import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as assistantConfig from "../lib/assistant-config.js";
import * as localModeModule from "@mycadet/local-mode";
import * as rootSigningKey from "../lib/root-signing-key.js";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";

const realAssistantConfig = { ...assistantConfig };
const realLocalMode = { ...localModeModule };
const realRootSigningKey = { ...rootSigningKey };

const resolveTargetAssistantMock =
  mock<typeof assistantConfig.resolveTargetAssistant>();
const loadAllAssistantsMock = mock<typeof localModeModule.loadAllAssistants>(
  () => [],
);
const saveLockfileAssistantMock = mock<
  typeof localModeModule.saveLockfileAssistant
>(() => ({ ok: true, lockfile: { assistants: [], activeAssistant: null } }));

mock.module("../lib/assistant-config.js", () => ({
  ...realAssistantConfig,
  resolveTargetAssistant: resolveTargetAssistantMock,
}));

// The command delegates to the package's wake operation — the arms (local
// daemon, docker containers, recreate-on-first-wake, narration) live in the
// package's own suites; this file pins the CLI shell around them.
const wakeAssistantMock = mock<typeof localModeModule.wakeAssistant>(
  async () => ({ ok: true }),
);
const waitForDaemonReadyMock = mock<typeof localModeModule.waitForDaemonReady>(
  async () => true,
);
mock.module("@mycadet/local-mode", () => ({
  ...realLocalMode,
  saveLockfileAssistant: saveLockfileAssistantMock,
  loadAllAssistants: loadAllAssistantsMock,
  wakeAssistant: wakeAssistantMock,
  waitForDaemonReady: waitForDaemonReadyMock,
}));

// Defaults to the real writer: repair tests assert the key file's contents.
const persistRootSigningKeyMock = mock<
  typeof rootSigningKey.persistRootSigningKey
>(realRootSigningKey.persistRootSigningKey);

mock.module("../lib/root-signing-key.js", () => ({
  ...realRootSigningKey,
  persistRootSigningKey: persistRootSigningKeyMock,
}));

const { wake } = await import("../commands/wake.js");

let tempDir: string;
let originalArgv: string[];
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let localEntry: LockfileAssistant;

function makeLocalEntry(): LockfileAssistant {
  tempDir = mkdtempSync(join(tmpdir(), "cadet-wake-test-"));
  return {
    assistantId: "local-assistant",
    cloud: "local",
    instanceDir: tempDir,
    daemonPort: 7821,
    port: 7830,
    cesPort: 7822,
  };
}

beforeEach(() => {
  originalArgv = [...process.argv];
  tempDir = "";
  process.argv = ["bun", "cadet", "wake", "--watch", "local-assistant"];
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});

  localEntry = makeLocalEntry();
  resolveTargetAssistantMock.mockReset();
  resolveTargetAssistantMock.mockReturnValue(localEntry);
  loadAllAssistantsMock.mockReset();
  loadAllAssistantsMock.mockReturnValue([]);
  saveLockfileAssistantMock.mockReset();
  saveLockfileAssistantMock.mockImplementation(() => ({
    ok: true,
    lockfile: { assistants: [], activeAssistant: null },
  }));
  wakeAssistantMock.mockReset();
  wakeAssistantMock.mockResolvedValue({ ok: true });
  waitForDaemonReadyMock.mockReset();
  waitForDaemonReadyMock.mockResolvedValue(true);
  persistRootSigningKeyMock.mockReset();
  persistRootSigningKeyMock.mockImplementation(
    realRootSigningKey.persistRootSigningKey,
  );
});

afterEach(() => {
  process.argv = originalArgv;
  logSpy.mockRestore();
  errorSpy.mockRestore();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  mock.module("@mycadet/local-mode", () => realLocalMode);
  mock.module("../lib/assistant-config.js", () => realAssistantConfig);
  mock.module("../lib/root-signing-key.js", () => realRootSigningKey);
});

describe("cadet wake — the CLI shell around the wake operation", () => {
  test("a single wake delegates the resolved entry and launch opts", async () => {
    process.argv = ["bun", "cadet", "wake", "--watch", "local-assistant"];

    await wake();

    expect(wakeAssistantMock).toHaveBeenCalledWith(localEntry, {
      watch: true,
    });
    expect(logSpy).toHaveBeenCalledWith("Wake complete.");
  });

  test("a failed single wake renders the operation's error and exits 1", async () => {
    wakeAssistantMock.mockResolvedValue({
      ok: false,
      status: 500,
      error: "ces spawn failed",
    });
    process.argv = ["bun", "cadet", "wake", "local-assistant"];

    const exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number | string | undefined): never => {
        throw new Error(`process.exit:${code}`);
      },
    );

    try {
      await expect(wake()).rejects.toThrow("process.exit:1");
      expect(errorSpy).toHaveBeenCalledWith("Error: ces spawn failed");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("cadet wake --all", () => {
  function makeAllEntry(
    assistantId: string,
    instanceDir: string,
  ): LockfileAssistant {
    return {
      assistantId,
      cloud: "local",
      instanceDir,
      daemonPort: 7821,
      port: 7830,
      cesPort: 7822,
    };
  }

  function makeAllEntries(): LockfileAssistant[] {
    return [
      makeAllEntry("wake-all-1", join(tempDir, "instance-1")),
      makeAllEntry("wake-all-2", join(tempDir, "instance-2")),
    ];
  }

  test("starts every assistant in the lockfile", async () => {
    loadAllAssistantsMock.mockReturnValue(makeAllEntries());
    process.argv = ["bun", "cadet", "wake", "--all"];

    await wake();

    expect(wakeAssistantMock).toHaveBeenCalledTimes(2);
    expect(
      (wakeAssistantMock.mock.calls[0]![0] as LockfileAssistant).assistantId,
    ).toBe("wake-all-1");
    expect(
      (wakeAssistantMock.mock.calls[1]![0] as LockfileAssistant).assistantId,
    ).toBe("wake-all-2");
    // The batch rides the same launch opts as the single path.
    expect(wakeAssistantMock.mock.calls[0]![1]).toEqual({
      watch: false,
    });
  });

  test("continues past a failing assistant and exits 1", async () => {
    // A real wake failure for the first entry; the loop still wakes the rest.
    wakeAssistantMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: "ces spawn failed",
    });
    loadAllAssistantsMock.mockReturnValue(makeAllEntries());
    process.argv = ["bun", "cadet", "wake", "--all"];

    const exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number | string | undefined): never => {
        throw new Error(`process.exit:${code}`);
      },
    );

    try {
      await expect(wake()).rejects.toThrow("process.exit:1");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed to wake 'wake-all-1'"),
      );
    } finally {
      exitSpy.mockRestore();
    }

    // Both assistants attempted their wakes.
    expect(wakeAssistantMock).toHaveBeenCalledTimes(2);
  });

  test("exits 1 when there is nothing to start", async () => {
    loadAllAssistantsMock.mockReturnValue([]);
    process.argv = ["bun", "cadet", "wake", "--all"];

    const exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number | string | undefined): never => {
        throw new Error(`process.exit:${code}`);
      },
    );

    try {
      await expect(wake()).rejects.toThrow("process.exit:1");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("no assistants found"),
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("refuses --all combined with a name", async () => {
    process.argv = ["bun", "cadet", "wake", "local-assistant", "--all"];

    const exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number | string | undefined): never => {
        throw new Error(`process.exit:${code}`);
      },
    );

    try {
      await expect(wake()).rejects.toThrow("process.exit:1");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("--all cannot be combined"),
      );
    } finally {
      exitSpy.mockRestore();
    }
  });
});
