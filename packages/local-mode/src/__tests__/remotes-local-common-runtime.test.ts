import { describe, expect, test } from "bun:test";

import { isValidReleaseVersion } from "@mycadet/local-mode";

import { ensureLocalRuntime } from "../remotes/local/common";

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
