import { describe, expect, test } from "bun:test";

import { displayVersion } from "../lib/local-version.js";
import { environmentFromVersion } from "../lib/environments/resolve.js";
import { isLocalVersion, parseVersion } from "../lib/version-compat.js";

describe("displayVersion", () => {
  test("stamps source checkouts with a -local. postfix in the dev-release format", () => {
    // In the repo the CLI always runs as Bun-executed TypeScript with git
    // history, so the stamp applies. Format mirrors dev-release.yaml:
    // `<base>-local.<yyyymmddhhmm>.<shortsha>`.
    expect(displayVersion("0.13.0")).toMatch(
      /^0\.13\.0-local\.\d{12}\.[0-9a-f]{7,}$/,
    );
  });

  test("stamped version parses as semver and denotes a local build", () => {
    const version = displayVersion("0.13.0");
    expect(parseVersion(version)?.pre).toMatch(/^local\.\d{12}\.[0-9a-f]{7,}$/);
    expect(isLocalVersion(version)).toBe(true);
  });

  test("stamped version resolves the local environment via the shared mapping", () => {
    // `cadet-local` pins CADET_ENVIRONMENT anyway, but the version stamp and
    // the environment mapping must agree so a source checkout is legible as
    // a local build no matter which signal is consulted.
    expect(environmentFromVersion(displayVersion("0.13.0"))).toBe("local");
  });

  test("non-source entries keep the plain package version", () => {
    // Compiled installs run from a non-.ts entry: no stamp, so the release
    // pipeline's version stays authoritative there.
    expect(displayVersion("0.13.0", new Date(), "/usr/local/bin/mycadet")).toBe(
      "0.13.0",
    );
  });

  test("source trees without git history stay unstamped", () => {
    // The sha is what makes the stamp meaningful; a tarball checkout can't
    // produce one, so it keeps the plain version rather than a half-stamp.
    expect(
      displayVersion("0.13.0", new Date(), "/opt/src/cli/src/index.ts"),
    ).toBe("0.13.0");
  });
});
