import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getGuardianAccessToken,
  formatGuardianRefreshCliFailure,
  parseGuardianRefreshCliFailure,
  isConfidentialRefreshUrl,
  saveBasetenSandboxToken,
  saveGuardianToken,
  type GuardianTokenData,
} from "../guardian-token";
import { saveLockfileAssistant } from "../lockfile";
import { isLoopbackPublicUrl } from "@mycadet/service-contracts/remote-web-pairing";
import type { CliInvocation } from "../util";

// An invocation that would fail loudly if any tested branch spawned the CLI.
const invocation: CliInvocation = { command: "false", baseArgs: [] };

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

function makeTokenData(over: Partial<GuardianTokenData>): GuardianTokenData {
  return {
    guardianPrincipalId: "principal",
    accessToken: "access",
    accessTokenExpiresAt: FUTURE,
    refreshToken: "refresh",
    refreshTokenExpiresAt: FUTURE,
    refreshAfter: FUTURE,
    isNew: false,
    deviceId: "device",
    leasedAt: new Date().toISOString(),
    ...over,
  };
}

describe("getGuardianAccessToken", () => {
  let configDir: string;

  beforeEach(() => {
    // The token paths resolve from the environment: XDG config home plus the
    // production environment dir, so the fixture points XDG at the tmp home
    // and reads back through the same ambient resolution.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-token-test-"));
    process.env.XDG_CONFIG_HOME = home;
    configDir = path.join(home, "cadet");
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
    fs.rmSync(path.dirname(configDir), { recursive: true, force: true });
  });

  test("returns the stored token while the access token is fresh", async () => {
    saveGuardianToken("asst-1", makeTokenData({}));

    expect(await getGuardianAccessToken("asst-1", invocation)).toEqual({
      ok: true,
      accessToken: "access",
    });
  });

  test("returns a structured 404 when no token file exists", async () => {
    expect(await getGuardianAccessToken("missing", invocation)).toEqual({
      ok: false,
      status: 404,
      error: "Guardian token not found",
    });
  });

  test("expired refresh token yields hatch/wake guidance by default", async () => {
    saveGuardianToken(
      "asst-1",
      makeTokenData({
        accessTokenExpiresAt: PAST,
        refreshTokenExpiresAt: PAST,
      }),
    );

    const result = await getGuardianAccessToken("asst-1", invocation);

    expect(result).toEqual({
      ok: false,
      status: 401,
      error: "Guardian token expired. Re-run `cadet hatch` or `cadet wake`.",
    });
  });

  test("expired refresh token yields re-pair guidance for a paired entry", async () => {
    saveGuardianToken(
      "asst-1",
      makeTokenData({
        accessTokenExpiresAt: PAST,
        refreshTokenExpiresAt: PAST,
        pairedGatewayUrl: "https://gateway.example.com",
      }),
    );

    const result = await getGuardianAccessToken("asst-1", invocation);

    expect(result).toEqual({
      ok: false,
      status: 401,
      error:
        "Guardian token expired. Run `cadet pair` on the assistant's machine, then re-import it from the app's connect flow or with `cadet connect import`.",
    });
  });
});

describe("parseGuardianRefreshCliFailure", () => {
  test("reads a labeled 401 from stderr", () => {
    expect(
      parseGuardianRefreshCliFailure(
        "",
        `Failed to refresh guardian token.\n${formatGuardianRefreshCliFailure(401, "Failed to refresh guardian token")}\n`,
      ),
    ).toEqual({
      ok: false,
      status: 401,
      error: "Failed to refresh guardian token",
    });
  });

  test("reads a labeled 503 from stderr", () => {
    expect(
      parseGuardianRefreshCliFailure(
        "",
        formatGuardianRefreshCliFailure(
          503,
          "Assistant gateway is unreachable",
        ),
      ),
    ).toEqual({
      ok: false,
      status: 503,
      error: "Assistant gateway is unreachable",
    });
  });

  test("an unlabeled non-zero CLI exit is a 503, not a 401", () => {
    expect(
      parseGuardianRefreshCliFailure("", "Failed to refresh guardian token."),
    ).toEqual({
      ok: false,
      status: 503,
      error: "Failed to refresh guardian token",
    });
  });
});

describe("isConfidentialRefreshUrl", () => {
  test.each([
    ["https://gw.example.com", "https reaches it encrypted"],
    ["http://localhost:7830", "exact localhost stays on this machine"],
    ["http://127.0.0.5:7830", "127/8 stays on this machine"],
    ["http://[::1]:7830", "IPv6 loopback stays on this machine"],
    ["http://localhost.:7830", "an absolute localhost name is the same host"],
    ["http://0.0.0.0:7830", "a wildcard bind dials a local listener"],
  ])("%s is confidential (%s)", (url) => {
    expect(isConfidentialRefreshUrl(url)).toBe(true);
  });

  test.each([
    ["http://gw.example.com", "plaintext to a public host"],
    ["http://10.0.0.5:7830", "plaintext to a private address"],
    ["not a url", "an unparseable value"],
  ])("%s is not confidential (%s)", (url) => {
    expect(isConfidentialRefreshUrl(url)).toBe(false);
  });

  test("a reserved .localhost name is refused plaintext", () => {
    // RFC 6761 says a resolver should map the whole `.localhost` namespace to
    // loopback; glibc does not by default, so this name can answer with any
    // address. Treating it as confidential would put a long-lived, replayable
    // refresh token on the wire in plaintext to whatever answered.
    for (const url of [
      "http://evil.localhost:8080",
      "http://evil.localhost.:8080",
      "http://a.b.localhost",
    ]) {
      expect(isConfidentialRefreshUrl(url)).toBe(false);
      // The pairing side still refuses it as loopback: a name that might be
      // local is refused by the guards that refuse loopback and denied by the
      // guards that reward it.
      expect(isLoopbackPublicUrl(url)).toBe(true);
    }
  });

  test("https to a .localhost name is confidential on the protocol alone", () => {
    expect(isConfidentialRefreshUrl("https://evil.localhost:8443")).toBe(true);
  });
});

describe("getPairedGuardianAccessToken — baseten sandboxes", () => {
  let configDir: string;

  beforeEach(() => {
    // Same ambient-resolution fixture as the guardian tests: XDG at the tmp
    // home, reads and writes through the production environment dir.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baseten-token-test-"));
    process.env.XDG_CONFIG_HOME = home;
    configDir = path.join(home, "cadet");
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
    fs.rmSync(path.dirname(configDir), { recursive: true, force: true });
  });

  test("a baseten entry reads the saved sandbox token and never leases", async () => {
    // The invocation fails loudly if any branch spawns the CLI — the baseten
    // credential is a file read, not a lease.
    saveLockfileAssistant({
      assistantId: "asst_bx",
      cloud: "baseten",
      sandboxUrl: "https://sbx-name-abc123.us-pdx-1.b10.co",
      port: 7830,
    });
    saveBasetenSandboxToken("asst_bx", "sbx-token-1");

    expect(await getGuardianAccessToken("asst_bx", invocation)).toEqual({
      ok: true,
      accessToken: "sbx-token-1",
    });
  });

  test("a missing token file is a structured 404, not a throw", async () => {
    saveLockfileAssistant({
      assistantId: "asst_bx",
      cloud: "baseten",
      sandboxUrl: "https://sbx-name-abc123.us-pdx-1.b10.co",
      port: 7830,
    });

    expect(await getGuardianAccessToken("asst_bx", invocation)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  test("a non-baseten entry still leases through the guardian path", async () => {
    saveLockfileAssistant({ assistantId: "asst_local", cloud: "local" });

    // No token file for the local entry: the guardian path answers with the
    // structured 404 (the baseten branch did not intercept).
    expect(
      await getGuardianAccessToken("asst_local", invocation),
    ).toMatchObject({ ok: false, status: 404 });
  });

  test("the token file is saved 0600 under the assistants dir", () => {
    saveBasetenSandboxToken("asst_bx", "t");

    const stat = fs.statSync(
      path.join(configDir, "assistants", "asst_bx", "baseten-token.json"),
    );
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
