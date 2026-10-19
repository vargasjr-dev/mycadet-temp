import { describe, expect, test } from "bun:test";

import {
  buildNgrokSpawnArgs,
  isNgrokAuthError,
  isNgrokSessionLimitError,
  ngrokAgentConfigPath,
} from "../lib/tunnels/ngrok.js";

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

  test("a second agent layers the user's default config under ours", () => {
    // Order is load-bearing: the default config carries the authtoken, ours
    // wins for web_addr. A bare --config would replace the default and drop
    // the token.
    const args = buildNgrokSpawnArgs(7840, "me.ngrok.app", {
      webAddr: "127.0.0.1:4041",
      defaultConfigPath: "/users/me/.config/ngrok/ngrok.yml",
    });
    expect(args).toEqual([
      "http",
      "127.0.0.1:7840",
      "--log=stdout",
      "--domain=me.ngrok.app",
      "--config=/users/me/.config/ngrok/ngrok.yml",
      `--config=${ngrokAgentConfigPath()}`,
    ]);
  });

  test("a second agent without a resolvable default config still sets its inspection address", () => {
    const args = buildNgrokSpawnArgs(7840, undefined, {
      webAddr: "127.0.0.1:4041",
    });
    expect(args).toEqual([
      "http",
      "127.0.0.1:7840",
      "--log=stdout",
      `--config=${ngrokAgentConfigPath()}`,
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

  test("recognizes the concurrent-agent session limit", () => {
    expect(
      isNgrokSessionLimitError(
        "authentication failed: Your account is limited to 3 simultaneous ngrok agent sessions. ERR_NGROK_108",
      ),
    ).toBe(true);
    expect(isNgrokSessionLimitError("connection refused")).toBe(false);
  });
});
