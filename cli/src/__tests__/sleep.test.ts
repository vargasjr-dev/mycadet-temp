import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CES_PORT,
  DEFAULT_DAEMON_PORT,
  DEFAULT_GATEWAY_PORT,
} from "../lib/constants.js";

// Create a temp directory and set XDG_CONFIG_HOME so the real
// assistant-config module reads/writes the lockfile here instead of ~/.
const testDir = mkdtempSync(join(tmpdir(), "sleep-command-test-"));
process.env.XDG_CONFIG_HOME = testDir;

// The command is a thin shell now: the headless core lives in the
// local-mode package's sleep operation, and these tests pin the SHELL —
// flag parsing, target resolution, narration, exit codes — by mocking the
// operation at the package boundary. Everything else in the namespace stays
// real (parseWaitDuration, cliCommand, loadAllAssistants read the sandbox).
const realLocalMode = { ...(await import("@mycadet/local-mode")) };
const sleepAssistantMock = mock(
  async (
    _entry: import("@mycadet/local-mode").LockfileAssistant,
    _opts?: import("@mycadet/local-mode").SleepOptions,
  ): Promise<import("@mycadet/local-mode").SleepResult> => ({
    ok: true,
    kind: "services",
    services: { assistant: "stopped", gateway: "stopped", ces: "stopped" },
    notes: [],
  }),
);
mock.module("@mycadet/local-mode", () => ({
  ...realLocalMode,
  sleepAssistant: sleepAssistantMock,
}));

// Restore the real module once this file finishes so the mock does not leak
// into other test files in the same `bun test` run.
afterAll(() => {
  mock.module("@mycadet/local-mode", () => realLocalMode);
});

import { sleep } from "../commands/sleep.js";

// Write a lockfile entry so the real resolveTargetAssistant() finds our test
// assistant without needing to mock the entire assistant-config module.
function writeLockfile(extraEntryFields: Record<string, unknown> = {}): void {
  mkdirSync(join(testDir, "cadet"), { recursive: true });
  writeFileSync(
    join(testDir, "cadet", "lockfile.json"),
    JSON.stringify(
      {
        assistants: [
          {
            assistantId: "sleep-test",
            runtimeUrl: `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`,
            cloud: "local",
            instanceDir: testDir,
            daemonPort: DEFAULT_DAEMON_PORT,
            port: DEFAULT_GATEWAY_PORT,
            cesPort: DEFAULT_CES_PORT,
            ...extraEntryFields,
          },
        ],
        activeAssistant: "sleep-test",
      },
      null,
      2,
    ),
  );
}

function writeMultiAssistantLockfile(): void {
  writeFileSync(
    join(testDir, "cadet", "lockfile.json"),
    JSON.stringify(
      {
        assistants: [
          {
            assistantId: "sleep-all-1",
            runtimeUrl: `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`,
            cloud: "local",
            instanceDir: join(testDir, "instance-1"),
            daemonPort: DEFAULT_DAEMON_PORT,
            port: DEFAULT_GATEWAY_PORT,
            cesPort: DEFAULT_CES_PORT,
          },
          {
            assistantId: "sleep-all-2",
            runtimeUrl: `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`,
            cloud: "local",
            instanceDir: join(testDir, "instance-2"),
            daemonPort: DEFAULT_DAEMON_PORT,
            port: DEFAULT_GATEWAY_PORT,
            cesPort: DEFAULT_CES_PORT,
          },
        ],
        activeAssistant: "sleep-all-1",
      },
      null,
      2,
    ),
  );
}

/** A process.exit that records instead of unwinding. */
function recordExit(): {
  exitMock: ReturnType<typeof mock>;
  restore: () => void;
} {
  const exitMock = mock((() => undefined) as unknown as typeof process.exit);
  const originalExit = process.exit;
  process.exit = exitMock;
  return { exitMock, restore: () => (process.exit = originalExit) };
}

describe("sleep command", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = [...process.argv];
    sleepAssistantMock.mockReset();
    sleepAssistantMock.mockImplementation(async () => ({
      ok: true,
      kind: "services",
      services: { assistant: "stopped", gateway: "stopped", ces: "stopped" },
      notes: [],
    }));
    // Reset per-test state: drop the lockfile left behind.
    rmSync(join(testDir, "cadet", "lockfile.json"), { force: true });
    writeLockfile();
  });

  afterAll(() => {
    process.argv = originalArgv;
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
  });

  test("resolves the target and delegates with parsed options", async () => {
    process.argv = ["bun", "cadet", "sleep", "sleep-test", "--force"];
    const { exitMock, restore } = recordExit();

    try {
      await sleep();
    } finally {
      restore();
    }

    expect(sleepAssistantMock).toHaveBeenCalledTimes(1);
    const [entry, opts] = sleepAssistantMock.mock.calls[0]!;
    expect(entry.assistantId).toBe("sleep-test");
    expect(opts?.force).toBe(true);
    expect(opts?.wait).toBe(false);
    expect(opts?.waitMs).toBeNull();
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  test("narrates the per-service result", async () => {
    process.argv = ["bun", "cadet", "sleep"];
    const { restore } = recordExit();
    const consoleLog = spyOn(console, "log").mockImplementation(() => {});

    try {
      await sleep();

      expect(
        consoleLog.mock.calls.some(([l]) => l === "Assistant stopped."),
      ).toBe(true);
      expect(
        consoleLog.mock.calls.some(([l]) => l === "Gateway stopped."),
      ).toBe(true);
      expect(
        consoleLog.mock.calls.some(
          ([l]) => l === "credential-executor stopped.",
        ),
      ).toBe(true);
    } finally {
      restore();
      consoleLog.mockRestore();
    }
  });

  test("narrates services that were never running differently", async () => {
    process.argv = ["bun", "cadet", "sleep"];
    const { restore } = recordExit();
    const consoleLog = spyOn(console, "log").mockImplementation(() => {});
    sleepAssistantMock.mockImplementation(async () => ({
      ok: true,
      kind: "services",
      services: {
        assistant: "not-running",
        gateway: "stopped",
        ces: "not-running",
      },
      notes: [],
    }));

    try {
      await sleep();

      expect(
        consoleLog.mock.calls.some(([l]) => l === "Assistant is not running."),
      ).toBe(true);
      expect(
        consoleLog.mock.calls.some(([l]) => l === "Gateway stopped."),
      ).toBe(true);
      expect(
        consoleLog.mock.calls.some(
          ([l]) => l === "credential-executor stopped.",
        ),
      ).toBe(false);
    } finally {
      restore();
      consoleLog.mockRestore();
    }
  });

  test("prints the operation's degradation notes", async () => {
    process.argv = ["bun", "cadet", "sleep", "--wait"];
    const { restore } = recordExit();
    const consoleLog = spyOn(console, "log").mockImplementation(() => {});
    sleepAssistantMock.mockImplementation(async () => ({
      ok: true,
      kind: "services",
      services: { assistant: "stopped", gateway: "stopped", ces: "stopped" },
      notes: [
        "This assistant version does not support --wait — stopping without waiting.",
      ],
    }));

    try {
      await sleep();

      expect(
        consoleLog.mock.calls.some(([l]) =>
          String(l).includes("does not support --wait"),
        ),
      ).toBe(true);
    } finally {
      restore();
      consoleLog.mockRestore();
    }
  });

  test("docker containers narrate their own line", async () => {
    process.argv = ["bun", "cadet", "sleep"];
    const { restore } = recordExit();
    const consoleLog = spyOn(console, "log").mockImplementation(() => {});
    sleepAssistantMock.mockImplementation(async () => ({
      ok: true,
      kind: "containers",
    }));

    try {
      await sleep();

      expect(
        consoleLog.mock.calls.some(([l]) => l === "Docker containers stopped."),
      ).toBe(true);
    } finally {
      restore();
      consoleLog.mockRestore();
    }
  });

  test("a failed stop reports the operation's detail and exits 1", async () => {
    process.argv = ["bun", "cadet", "sleep", "sleep-test"];
    const exitMock = mock((code?: number | string | undefined): never => {
      throw new Error(`process.exit:${code}`);
    });
    const originalExit = process.exit;
    process.exit = exitMock;
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    sleepAssistantMock.mockImplementation(async () => ({
      ok: false,
      status: 409,
      error:
        "assistant is staying awake for active phone calls (call-1). Use 'cadet sleep --force' to stop it anyway.",
    }));

    try {
      await expect(sleep()).rejects.toThrow("process.exit:1");
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("active phone calls"),
      );
    } finally {
      process.exit = originalExit;
      consoleError.mockRestore();
    }
  });

  test("a cancelled drain exits 130 with the cancel line", async () => {
    process.argv = ["bun", "cadet", "sleep", "--wait"];
    const exitMock = mock((code?: number | string | undefined): never => {
      throw new Error(`process.exit:${code}`);
    });
    const originalExit = process.exit;
    process.exit = exitMock;
    const consoleLog = spyOn(console, "log").mockImplementation(() => {});
    sleepAssistantMock.mockImplementation(async () => ({
      ok: true,
      cancelled: true,
    }));

    try {
      await expect(sleep()).rejects.toThrow("process.exit:130");
      expect(consoleLog).toHaveBeenCalledWith(
        "Sleep cancelled — the assistant is still running.",
      );
    } finally {
      process.exit = originalExit;
      consoleLog.mockRestore();
    }
  });

  test("rejects an unknown flag", async () => {
    process.argv = ["bun", "cadet", "sleep", "--force-all"];
    const exitMock = mock((code?: number | string | undefined): never => {
      throw new Error(`process.exit:${code}`);
    });
    const originalExit = process.exit;
    process.exit = exitMock;
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(sleep()).rejects.toThrow("process.exit:1");
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unknown sleep option"),
      );
    } finally {
      process.exit = originalExit;
      consoleError.mockRestore();
    }

    expect(sleepAssistantMock).not.toHaveBeenCalled();
  });

  test("rejects an invalid --wait duration", async () => {
    process.argv = ["bun", "cadet", "sleep", "--wait=abc"];
    const exitMock = mock((code?: number | string | undefined): never => {
      throw new Error(`process.exit:${code}`);
    });
    const originalExit = process.exit;
    process.exit = exitMock;
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(sleep()).rejects.toThrow("process.exit:1");
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("invalid --wait duration"),
      );
    } finally {
      process.exit = originalExit;
      consoleError.mockRestore();
    }

    expect(sleepAssistantMock).not.toHaveBeenCalled();
  });

  describe("--all", () => {
    test("stops every assistant in the lockfile", async () => {
      writeMultiAssistantLockfile();
      process.argv = ["bun", "cadet", "sleep", "--all"];
      const { restore } = recordExit();
      const consoleLog = spyOn(console, "log").mockImplementation(() => {});

      try {
        await sleep();

        expect(sleepAssistantMock).toHaveBeenCalledTimes(2);
        expect(sleepAssistantMock.mock.calls[0]![0].assistantId).toBe(
          "sleep-all-1",
        );
        expect(sleepAssistantMock.mock.calls[1]![0].assistantId).toBe(
          "sleep-all-2",
        );
      } finally {
        restore();
        consoleLog.mockRestore();
      }
    });

    test("continues past a failing assistant and exits 1", async () => {
      writeMultiAssistantLockfile();
      process.argv = ["bun", "cadet", "sleep", "--all"];
      const exitMock = mock((code?: number | string | undefined): never => {
        throw new Error(`process.exit:${code}`);
      });
      const originalExit = process.exit;
      process.exit = exitMock;
      const consoleError = spyOn(console, "error").mockImplementation(() => {});
      sleepAssistantMock.mockImplementation(async (entry) =>
        entry.assistantId === "sleep-all-1"
          ? { ok: false, status: 409, error: "refused" }
          : {
              ok: true,
              kind: "services",
              services: {
                assistant: "stopped",
                gateway: "stopped",
                ces: "stopped",
              },
              notes: [],
            },
      );

      try {
        await expect(sleep()).rejects.toThrow("process.exit:1");
        expect(
          consoleError.mock.calls.some(([line]) =>
            String(line).includes("failed to stop 'sleep-all-1'"),
          ),
        ).toBe(true);

        // The healthy assistant was still stopped.
        expect(sleepAssistantMock).toHaveBeenCalledTimes(2);
      } finally {
        process.exit = originalExit;
        consoleError.mockRestore();
      }
    });

    test("skips apple-container assistants with the managed-elsewhere line", async () => {
      writeLockfile({ cloud: "apple-container", mgmtSocket: "/tmp/mgmt.sock" });
      process.argv = ["bun", "cadet", "sleep", "--all"];
      const { restore } = recordExit();
      const consoleLog = spyOn(console, "log").mockImplementation(() => {});

      try {
        await sleep();

        expect(sleepAssistantMock).not.toHaveBeenCalled();
        expect(
          consoleLog.mock.calls.some(([l]) =>
            String(l).includes("its lifecycle is managed elsewhere"),
          ),
        ).toBe(true);
      } finally {
        restore();
        consoleLog.mockRestore();
      }
    });

    test("exits 1 when there is nothing to stop", async () => {
      rmSync(join(testDir, "cadet", "lockfile.json"), { force: true });
      process.argv = ["bun", "cadet", "sleep", "--all"];
      const exitMock = mock((code?: number | string | undefined): never => {
        throw new Error(`process.exit:${code}`);
      });
      const originalExit = process.exit;
      process.exit = exitMock;
      const consoleError = spyOn(console, "error").mockImplementation(() => {});

      try {
        await expect(sleep()).rejects.toThrow("process.exit:1");
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining("no assistants found"),
        );
      } finally {
        process.exit = originalExit;
        consoleError.mockRestore();
      }
    });

    test("refuses --all combined with a name", async () => {
      process.argv = ["bun", "cadet", "sleep", "sleep-test", "--all"];
      const exitMock = mock((code?: number | string | undefined): never => {
        throw new Error(`process.exit:${code}`);
      });
      const originalExit = process.exit;
      process.exit = exitMock;
      const consoleError = spyOn(console, "error").mockImplementation(() => {});

      try {
        await expect(sleep()).rejects.toThrow("process.exit:1");
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining("--all cannot be combined"),
        );
      } finally {
        process.exit = originalExit;
        consoleError.mockRestore();
      }
    });
  });
});
