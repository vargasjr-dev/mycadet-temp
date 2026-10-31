import { describe, expect, test } from "bun:test";

import {
  buildNgrokSpawnArgs,
  confirmStopAnswer,
  isNgrokAuthError,
  isNgrokEndpointOnlineError,
  isNgrokSessionLimitError,
  ngrokAgentConfigPath,
  ngrokOnlineEndpoint,
  staleTrackedNgrokAgent,
} from "../lib/tunnels/ngrok.js";
import type { TunnelProcessRecord } from "@mycadet/local-mode/contract";

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

describe("isNgrokEndpointOnlineError", () => {
  test("recognizes the free-plan domain collision", () => {
    expect(
      isNgrokEndpointOnlineError(
        "ERROR: failed to start tunnel: The endpoint 'https://camping-trustful-fog.ngrok-free.dev' is already online. ERR_NGROK_334",
      ),
    ).toBe(true);
  });

  test("does not claim other startup failures are endpoint collisions", () => {
    expect(
      isNgrokEndpointOnlineError(
        "creating tunnel session failed: dial tcp 3.219.x.x:443: connection refused",
      ),
    ).toBe(false);
  });
});

describe("ngrokOnlineEndpoint", () => {
  test("extracts the endpoint the incident refused", () => {
    expect(
      ngrokOnlineEndpoint(
        "failed to start tunnel: The endpoint 'https://camping-trustful-fog.ngrok-free.dev' is already online.",
      ),
    ).toBe("https://camping-trustful-fog.ngrok-free.dev");
  });

  test("no endpoint named, no extraction", () => {
    expect(
      ngrokOnlineEndpoint("creating tunnel session failed: connection refused"),
    ).toBeNull();
  });
});

describe("confirmStopAnswer", () => {
  test("Enter and y/yes confirm the stop", () => {
    expect(confirmStopAnswer("")).toBe(true);
    expect(confirmStopAnswer("y")).toBe(true);
    expect(confirmStopAnswer("  YES\n")).toBe(true);
  });

  test("anything else declines", () => {
    expect(confirmStopAnswer("n")).toBe(false);
    expect(confirmStopAnswer("no")).toBe(false);
    expect(confirmStopAnswer("wait")).toBe(false);
  });
});

describe("staleTrackedNgrokAgent", () => {
  const record: TunnelProcessRecord = {
    pid: 4242,
    provider: "ngrok",
    startedAt: new Date().toISOString(),
  };

  test("returns the record for a tracked, live ngrok agent", () => {
    expect(staleTrackedNgrokAgent(record, () => true)).toEqual(record);
  });

  test("leaves agents recorded by other tunnel providers alone", () => {
    expect(
      staleTrackedNgrokAgent({ ...record, provider: "tailscale" }, () => true),
    ).toBeNull();
  });

  test("leaves a pid that no longer verifies as ngrok alone (reuse guard)", () => {
    expect(staleTrackedNgrokAgent(record, () => false)).toBeNull();
  });

  test("nothing recorded, nothing to stop", () => {
    expect(staleTrackedNgrokAgent(undefined, () => true)).toBeNull();
  });
});
