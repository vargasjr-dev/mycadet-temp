import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isValidReleaseVersion } from "../upgrade";

import {
  ensureLocalRuntime,
  getLocalRuntimeInstallDir,
} from "../remotes/local/common";

// Snapshot the real child_process before mocking so the module-scoped
// `afterAll` can restore it — bun runs every test file in one process with
// a shared loader, and `mock.restore()` does not undo `mock.module()`.
const realChildProcess = { ...(await import("node:child_process")) };

// The install leg shells out to bun twice: a --version probe
// (`ensureBunInstalled`) and the `bun install` itself. Both are stubbed so
// the manifest write and the component check are what the tests observe.
mock.module("node:child_process", () => ({
  ...realChildProcess,
  execFileSync: mock(() => ""),
  spawnSync: mock(() => ({ status: 0 })),
}));

afterAll(() => {
  mock.module("node:child_process", () => realChildProcess);
});

// Only `instanceDir` is read, and only after the validation guard passes —
// invalid versions throw before any filesystem access, so a minimal stub is
// sufficient for the rejection cases.
const entry = {
  assistantId: "asst_version-guard",
  cloud: "local" as const,
  instanceDir: "/tmp/cadet-nonexistent-instance",
  port: 0,
  daemonPort: 0,
};

const VALID_VERSIONS = ["latest", "v1.2.3", "1.2.3", "0.6.0-staging.5"];
const MALICIOUS_VERSIONS = [
  "npm:@attacker/evil@1.0.0",
  "https://evil.example/x.tgz",
  "git+https://evil.example/x.git",
  "../../../../tmp/evil",
  "1.2.3-..",
  "1.2.3-a..b",
];

describe("ensureLocalRuntime version guard", () => {
  test("shares the trusted-release validator with the host boundary", () => {
    for (const version of VALID_VERSIONS) {
      expect(isValidReleaseVersion(version)).toBe(true);
    }
    for (const version of MALICIOUS_VERSIONS) {
      expect(isValidReleaseVersion(version)).toBe(false);
    }
  });

  test("throws before any install for untrusted versions", () => {
    for (const version of MALICIOUS_VERSIONS) {
      expect(() => ensureLocalRuntime(entry, version)).toThrow(
        `Invalid runtime version '${version}'`,
      );
    }
  });
});

describe("ensureLocalRuntime runtime install", () => {
  test("installs the mycadet runtime metapackage at the requested version", () => {
    /**
     * The self-managed runtime's manifest must name the published Cadet
     * metapackage — the one whose dependencies are the @mycadet sources the
     * wake's resolvers probe. A stale package name here installs an
     * unrelated npm package (or fails the install outright), leaving the
     * resolvers with nothing.
     */

    // GIVEN a fresh instance with no runtime installed
    const installDir = mkdtempSync(join(tmpdir(), "cadet-runtime-install-"));
    const installEntry = {
      assistantId: "asst_runtime-install",
      cloud: "local" as const,
      instanceDir: installDir,
      port: 0,
      daemonPort: 0,
    };

    try {
      // WHEN the runtime installs (the stubbed bun writes no components, so
      // the post-install component check is what surfaces)
      expect(() => ensureLocalRuntime(installEntry, "v1.2.3")).toThrow(
        /missing assistant, gateway, or credential-executor/,
      );

      // THEN the manifest pinned the mycadet metapackage at the normalized
      // version
      const manifest = JSON.parse(
        readFileSync(
          join(
            getLocalRuntimeInstallDir(installEntry, "v1.2.3"),
            "package.json",
          ),
          "utf-8",
        ),
      );
      expect(manifest.private).toBe(true);
      expect(manifest.dependencies).toEqual({ mycadet: "1.2.3" });
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  });
});
