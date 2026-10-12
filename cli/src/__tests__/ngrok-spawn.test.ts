import { describe, expect, test } from "bun:test";

import { buildNgrokSpawnArgs, isNgrokAuthError } from "../lib/tunnels/ngrok.js";

describe("buildNgrokSpawnArgs", () => {
  test("spawns a plain http agent against the loopback edge", () => {
    expect(buildNgrokSpawnArgs(7830)).toEqual([
      "http",
      "127.0.0.1:7830",
      "--log=stdout",
    ]);
  });

  test("never passes --config so the default (authtoken-bearing) config loads", () => {
    const args = buildNgrokSpawnArgs(7830, "me.ngrok.app");
    expect(args.some((arg) => arg.startsWith("--config"))).toBe(false);
  });

  test("binds a reserved domain when given", () => {
    expect(buildNgrokSpawnArgs(7830, "my-assistant.ngrok.app")).toEqual([
      "http",
      "127.0.0.1:7830",
      "--log=stdout",
      "--domain=my-assistant.ngrok.app",
    ]);
  });
});

describe("isNgrokAuthError", () => {
  test("recognizes the free-account authtoken requirement", () => {
    expect(
      isNgrokAuthError(
        "FATAL: authentication failed: Usage of ngrok requires a free authtoken. ERR_NGROK_105",
      ),
    ).toBe(true);
  });

  test("recognizes an unauthorized token", () => {
    expect(isNgrokAuthError("unauthorized authtoken ERR_NGROK_401")).toBe(true);
  });

  test("does not claim other startup failures are auth errors", () => {
    expect(
      isNgrokAuthError(
        "creating tunnel session failed: dial tcp 3.219.x.x:443: connection refused",
      ),
    ).toBe(false);
  });
});
