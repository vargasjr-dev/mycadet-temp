import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";

import { stampedVersion } from "@mycadet/shared/version";
import {
  environmentFromVersion,
  getCurrentEnvironment,
} from "../lib/environments/resolve.js";
import { isLocalVersion, parseVersion } from "../lib/version-compat.js";

describe("stampedVersion", () => {
  test("stamps source checkouts with a -local. postfix in the dev-release format", () => {
    // In the repo the CLI always runs as Bun-executed TypeScript with git
    // history, so the stamp applies. Format mirrors dev-release.yaml:
    // `<base>-local.<yyyymmddhhmm>.<shortsha>`.
    expect(stampedVersion("0.13.0")).toMatch(
      /^0\.13\.0-local\.\d{12}\.[0-9a-f]{7,}$/,
    );
  });

  test("stamped version parses as semver and denotes a local build", () => {
    const version = stampedVersion("0.13.0");
    expect(parseVersion(version)?.pre).toMatch(/^local\.\d{12}\.[0-9a-f]{7,}$/);
    expect(isLocalVersion(version)).toBe(true);
  });

  test("stamped version resolves the local environment via the shared mapping", () => {
    // `cadet-local` pins CADET_ENVIRONMENT anyway, but the version stamp and
    // the environment mapping must agree so a source checkout is legible as
    // a local build no matter which signal is consulted.
    expect(environmentFromVersion(stampedVersion("0.13.0"))).toBe("local");
  });

  test("non-source entries keep the plain package version", () => {
    // Compiled installs run from a non-.ts entry: no stamp, so the release
    // pipeline's version stays authoritative there.
    expect(stampedVersion("0.13.0", new Date(), "/usr/local/bin/mycadet")).toBe(
      "0.13.0",
    );
  });

  test("source trees without git history stay unstamped", () => {
    // The sha is what makes the stamp meaningful; a tarball checkout can't
    // produce one, so it keeps the plain version rather than a half-stamp.
    expect(
      stampedVersion("0.13.0", new Date(), "/opt/src/cli/src/index.ts"),
    ).toBe("0.13.0");
  });

  test("the stamp's timestamp is the HEAD commit's, so a checkout stamps identically in every process", () => {
    // The stamp rides the edge's served-config fingerprint: a wall-clock
    // stamp would drift every CLI process and restart the edge on every
    // invocation. The commit time moves exactly when the sha does.
    const commitIso = execSync("git show -s --format=%cI HEAD")
      .toString()
      .trim();
    const stamp = new Date(commitIso)
      .toISOString()
      .replace(/[-:T]/g, "")
      .slice(0, 12);
    const sha = execSync("git rev-parse --short=7 HEAD").toString().trim();
    expect(stampedVersion("0.13.0")).toBe(`0.13.0-local.${stamp}.${sha}`);
  });

  test("installed .ts entries (node_modules) keep the plain package version", () => {
    // A global install ships the same .ts entries a checkout does, but it is
    // a released artifact: stamping it appended `-local.` to a `-dev.`
    // version (the channel lie behind `v0.13.0-dev.…-local.…` displays) and
    // leaked whatever upward `.git` the walk found into the version.
    expect(
      stampedVersion(
        "0.13.0-dev.202610252248.6747732",
        new Date(),
        "/home/dev/.bun/install/global/node_modules/@mycadet/shared/version.ts",
      ),
    ).toBe("0.13.0-dev.202610252248.6747732");
  });
});

describe("version-derived environment propagation", () => {
  test("getCurrentEnvironment propagates the version-derived environment for child processes", () => {
    // The incident this pins: a released `-dev.` CLI never set
    // CADET_ENVIRONMENT before commands resolved lockfile paths, so
    // local-mode's production fallback answered instead — pair minted
    // against another environment's lockfile (a retired assistant's dead
    // container) while up/tunnel, which DO call getCurrentEnvironment
    // first, wrote the right one. The propagation at the entry point is
    // what makes every downstream path resolution agree with the version.
    const prior = process.env.CADET_ENVIRONMENT;
    process.env.CADET_ENVIRONMENT = undefined;
    try {
      const env = getCurrentEnvironment();
      // Coerced: Bun's expect overloads choke on the `string | undefined`
      // env-index type here.
      expect(process.env.CADET_ENVIRONMENT ?? "(unset)").toBe(env.name);
    } finally {
      process.env.CADET_ENVIRONMENT = prior;
    }
  });
});
