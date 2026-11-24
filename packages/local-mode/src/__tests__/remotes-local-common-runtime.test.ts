import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { isValidReleaseVersion } from "../upgrade";

import {
  ensureLocalRuntime,
  localSourceCommandEntry,
} from "../remotes/local/common";

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

  test("throws before any install for untrusted versions", async () => {
    for (const version of MALICIOUS_VERSIONS) {
      await expect(ensureLocalRuntime(entry, version)).rejects.toThrow(
        `Invalid runtime version '${version}'`,
      );
    }
  });
});

test("assistants share a release and removing one selection preserves the other", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cadet-shared-runtime-"));
  const previous = process.env.BUN_INSTALL_GLOBAL_DIR;
  process.env.BUN_INSTALL_GLOBAL_DIR = join(directory, "global");
  try {
    const version = "1.2.3";
    const shared = join(directory, "global", "cadet-runtimes", version);
    for (const file of [
      "@mycadet/assistant/src/index.ts",
      "@mycadet/gateway/src/index.ts",
      "@mycadet/credential-executor/src/main.ts",
    ]) {
      const source = join(shared, "node_modules", file);
      mkdirSync(dirname(source), { recursive: true });
      writeFileSync(source, "");
    }
    const first = { ...entry, instanceDir: join(directory, "first") };
    const second = { ...entry, instanceDir: join(directory, "second") };
    const firstInstall = await ensureLocalRuntime(first, version);
    const secondInstall = await ensureLocalRuntime(second, version);
    expect(realpathSync(firstInstall.installDir)).toBe(realpathSync(shared));
    expect(realpathSync(secondInstall.installDir)).toBe(realpathSync(shared));
    rmSync(firstInstall.installDir, { recursive: true });
    expect(localSourceCommandEntry("assistant", second)).toBe(
      join(
        secondInstall.installDir,
        "node_modules",
        "@mycadet/assistant/src/index.ts",
      ),
    );
  } finally {
    if (previous === undefined) delete process.env.BUN_INSTALL_GLOBAL_DIR;
    else process.env.BUN_INSTALL_GLOBAL_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
