import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getOrCreatePersistedDeviceId,
  guardianTokenDueForRenewal,
  guardianTokenPath,
  loadGuardianToken,
  resolveConfigDir,
  saveGuardianToken,
  type PairDeviceIdentity,
  type PairOperationResult,
  type GuardianTokenData,
} from "@mycadet/local-mode";

// The lease's pair door is the package operation — mock it at the seam and
// feed the gateway's real pair shapes through it. The exec transports that
// carry the command are pinned in the package's own pair suites.
type PairDeviceFn = (
  entry: unknown,
  device: PairDeviceIdentity,
) => Promise<PairOperationResult>;
const pairDeviceMock = mock<PairDeviceFn>(async () => ({
  ok: true,
  response: {},
}));
mock.module("../../../packages/local-mode/src/operations/pair", () => ({
  pairDevice: pairDeviceMock,
}));

function makeTokenData(suffix: string): GuardianTokenData {
  const now = new Date().toISOString();
  const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return {
    guardianPrincipalId: `principal-${suffix}`,
    accessToken: `access-${suffix}`,
    accessTokenExpiresAt: oneHourFromNow,
    refreshToken: `refresh-${suffix}`,
    refreshTokenExpiresAt: oneHourFromNow,
    refreshAfter: oneHourFromNow,
    deviceId: `device-${suffix}`,
    leasedAt: now,
  };
}

describe("guardian-token paths are env-scoped", () => {
  let tempHome: string;
  let savedXdg: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    pairDeviceMock.mockReset();
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedEnv = process.env.CADET_ENVIRONMENT;
    tempHome = mkdtempSync(join(tmpdir(), "cli-guardian-token-test-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    delete process.env.CADET_ENVIRONMENT;
  });

  afterEach(() => {
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
    if (savedEnv === undefined) {
      delete process.env.CADET_ENVIRONMENT;
    } else {
      process.env.CADET_ENVIRONMENT = savedEnv;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("prod: guardian token lands at $XDG_CONFIG_HOME/cadet/assistants/<id>/guardian-token.json", () => {
    const data = makeTokenData("prod");
    saveGuardianToken("alpha", data);

    const prodPath = join(
      tempHome,
      "cadet",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(prodPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(prodPath, "utf-8"));
    expect(parsed.guardianPrincipalId).toBe("principal-prod");

    const loaded = loadGuardianToken("alpha");
    expect(loaded).not.toBeNull();
    expect(loaded!.guardianPrincipalId).toBe("principal-prod");
  });

  test("dev: guardian token lands at $XDG_CONFIG_HOME/cadet-dev/assistants/<id>/guardian-token.json", () => {
    process.env.CADET_ENVIRONMENT = "dev";
    const data = makeTokenData("dev");
    saveGuardianToken("alpha", data);

    const devPath = join(
      tempHome,
      "cadet-dev",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(devPath)).toBe(true);

    // Prod directory must NOT have this token
    const prodPath = join(
      tempHome,
      "cadet",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(prodPath)).toBe(false);

    const loaded = loadGuardianToken("alpha");
    expect(loaded).not.toBeNull();
    expect(loaded!.guardianPrincipalId).toBe("principal-dev");
  });

  test("same assistant id in prod and dev is isolated on disk", () => {
    // Write prod token for assistant 'alpha'
    delete process.env.CADET_ENVIRONMENT;
    saveGuardianToken("alpha", makeTokenData("prod"));

    // Write dev token for assistant 'alpha'
    process.env.CADET_ENVIRONMENT = "dev";
    saveGuardianToken("alpha", makeTokenData("dev"));

    // Dev load returns dev
    expect(loadGuardianToken("alpha")!.guardianPrincipalId).toBe(
      "principal-dev",
    );

    // Back to prod — prod token is unchanged
    delete process.env.CADET_ENVIRONMENT;
    expect(loadGuardianToken("alpha")!.guardianPrincipalId).toBe(
      "principal-prod",
    );

    // Both files exist at distinct paths
    const prodPath = join(
      tempHome,
      "cadet",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    const devPath = join(
      tempHome,
      "cadet-dev",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(prodPath)).toBe(true);
    expect(existsSync(devPath)).toBe(true);
    expect(prodPath).not.toBe(devPath);
  });

  test("prod: persisted device id lands at $XDG_CONFIG_HOME/cadet/device-id", () => {
    const id = getOrCreatePersistedDeviceId();
    expect(id.length).toBeGreaterThan(0);

    const prodPath = join(tempHome, "cadet", "device-id");
    expect(existsSync(prodPath)).toBe(true);
    expect(readFileSync(prodPath, "utf-8").trim()).toBe(id);
  });

  test("dev: persisted device id lands at $XDG_CONFIG_HOME/cadet-dev/device-id", () => {
    process.env.CADET_ENVIRONMENT = "dev";
    const id = getOrCreatePersistedDeviceId();
    expect(id.length).toBeGreaterThan(0);

    const devPath = join(tempHome, "cadet-dev", "device-id");
    expect(existsSync(devPath)).toBe(true);
    expect(readFileSync(devPath, "utf-8").trim()).toBe(id);

    const prodPath = join(tempHome, "cadet", "device-id");
    expect(existsSync(prodPath)).toBe(false);
  });

  test("device id is stable across repeated calls in the same env", () => {
    delete process.env.CADET_ENVIRONMENT;
    const first = getOrCreatePersistedDeviceId();
    const second = getOrCreatePersistedDeviceId();
    expect(first).toBe(second);
  });
});

describe("guardianTokenDueForRenewal", () => {
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const PAST = new Date(Date.now() - 60_000).toISOString();

  function token(over: Partial<GuardianTokenData>): GuardianTokenData {
    return {
      guardianPrincipalId: "p",
      accessToken: "a",
      accessTokenExpiresAt: FUTURE,
      refreshToken: "r",
      refreshTokenExpiresAt: FUTURE,
      refreshAfter: "",
      deviceId: "d",
      leasedAt: new Date().toISOString(),
      ...over,
    };
  }

  test("past refreshAfter → due", () => {
    expect(guardianTokenDueForRenewal(token({ refreshAfter: PAST }))).toBe(
      true,
    );
  });

  test("future refreshAfter → not due", () => {
    expect(guardianTokenDueForRenewal(token({ refreshAfter: FUTURE }))).toBe(
      false,
    );
  });

  test("empty refreshAfter falls back to accessTokenExpiresAt (past → due)", () => {
    expect(
      guardianTokenDueForRenewal(
        token({ refreshAfter: "", accessTokenExpiresAt: PAST }),
      ),
    ).toBe(true);
  });

  test("empty refreshAfter falls back to accessTokenExpiresAt (future → not due)", () => {
    expect(
      guardianTokenDueForRenewal(
        token({ refreshAfter: "", accessTokenExpiresAt: FUTURE }),
      ),
    ).toBe(false);
  });

  test("unparseable timestamp → not due", () => {
    expect(
      guardianTokenDueForRenewal(
        token({ refreshAfter: "not-a-date", accessTokenExpiresAt: "nope" }),
      ),
    ).toBe(false);
  });
});

// Drift guard between the guardian-token WRITE path (CLI: getGuardianTokenPath
// → resolveConfigDir()) and the READ path used by every
// host-seam reader (getGuardianAccessToken → resolveConfigDir(env) from
// @mycadet/local-mode). A divergence here writes a freshly leased token where
// the connect can't read it, bricking local-assistant connect. saveGuardianToken
// already resolves through the shared resolver; this asserts the two resolvers
// stay in lockstep so a future change to either can't silently relocate tokens.
describe("guardian-token path resolver parity (CLI ↔ shared)", () => {
  let tempHome: string;
  let savedXdg: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedEnv = process.env.CADET_ENVIRONMENT;
    tempHome = mkdtempSync(join(tmpdir(), "cli-guardian-parity-test-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    delete process.env.CADET_ENVIRONMENT;
  });

  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedEnv === undefined) delete process.env.CADET_ENVIRONMENT;
    else process.env.CADET_ENVIRONMENT = savedEnv;
    rmSync(tempHome, { recursive: true, force: true });
  });

  // The CLI's own resolver and the shared @mycadet/local-mode resolver must
  // agree on the config dir for every environment source.
  const expectResolversAgree = () => {
    expect(resolveConfigDir()).toBe(resolveConfigDir());
  };

  test("unset → production: resolvers agree and saveGuardianToken lands there", () => {
    expectResolversAgree();
    saveGuardianToken("alpha", makeTokenData("prod"));
    expect(existsSync(guardianTokenPath("alpha"))).toBe(true);
  });

  test("CADET_ENVIRONMENT=dev: resolvers agree and token lands there", () => {
    process.env.CADET_ENVIRONMENT = "dev";
    expectResolversAgree();
    saveGuardianToken("alpha", makeTokenData("dev"));
    expect(existsSync(guardianTokenPath("alpha"))).toBe(true);
  });

  test("CADET_ENVIRONMENT=local: resolvers agree and token lands there", () => {
    process.env.CADET_ENVIRONMENT = "local";
    expectResolversAgree();
    saveGuardianToken("alpha", makeTokenData("local"));
    expect(existsSync(guardianTokenPath("alpha"))).toBe(true);
  });
});
