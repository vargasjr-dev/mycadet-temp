import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDataDir, resolveInstanceDir } from "../config";
import { getDaemonPidPath, getLocalInstanceDir } from "../remotes/local/instance";
import type { LocalAssistant } from "../lockfile-contract";

const instanceRoot = join(resolveDataDir(), "assistants");

const localEntry = (overrides: Partial<LocalAssistant> = {}): LocalAssistant =>
  ({
    assistantId: "asst_instance-dir",
    cloud: "local",
    port: 0,
    ...overrides,
  }) as LocalAssistant;

afterEach(() => {
  try {
    rmSync(resolveInstanceDir("asst_instance-dir"), { recursive: true });
  } catch {
    // Nothing to clean up.
  }
});

describe("getLocalInstanceDir — the local assistant's data root", () => {
  test("honors the recorded instanceDir (legacy roots included)", () => {
    expect(
      getLocalInstanceDir(localEntry({ instanceDir: "/data/legacy-root" })),
    ).toBe("/data/legacy-root");
  });

  test("defaults to the assistant's own directory when none is recorded", () => {
    // The shared state root is never the answer: an entry that lost its
    // instanceDir still gets a directory of its own.
    expect(getLocalInstanceDir(localEntry())).toBe(
      resolveInstanceDir("asst_instance-dir"),
    );
  });

  test("the daemon pid file rides the instance dir", () => {
    expect(getDaemonPidPath(localEntry())).toBe(
      join(resolveInstanceDir("asst_instance-dir"), "workspace", "cadet.pid"),
    );
  });

  test("the default derivation works once the directory exists", () => {
    const dir = getLocalInstanceDir(localEntry());
    mkdirSync(dir, { recursive: true });
    expect(dir.startsWith(instanceRoot)).toBe(true);
  });
});

