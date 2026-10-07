import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetHostDeviceIdCache } from "../lib/device-id.js";
import type { DockerStatefulSetSpec } from "../lib/statefulset.js";
import { buildReplayEnv, buildReplayState } from "../lib/upgrade-lifecycle.js";
import { snapshotEnv } from "./helpers/env.js";

const restoreEnv = snapshotEnv([
  "CADET_PLATFORM_URL",
  "ANTHROPIC_API_KEY",
  "CADET_DEVICE_ID",
]);

afterEach(() => {
  restoreEnv();
  resetHostDeviceIdCache();
});

describe("buildReplayEnv", () => {
  test("gateway: drops secrets, statics, and PATH; keeps flag overrides", () => {
    const captured = {
      GUARDIAN_BOOTSTRAP_SECRET: "s1",
      CES_SERVICE_TOKEN: "s2",
      ACTOR_TOKEN_SIGNING_KEY: "s3",
      PATH: "/usr/bin",
      GATEWAY_PORT: "18080",
      CADET_DISABLE_PLATFORM: "1",
      CADET_DEVICE_ID: "abc",
    };

    expect(buildReplayEnv(captured, "gateway")).toEqual({
      CADET_DISABLE_PLATFORM: "1",
      CADET_DEVICE_ID: "abc",
    });
  });

  test("gateway: captured CADET_PLATFORM_URL dropped when set on host", () => {
    process.env.CADET_PLATFORM_URL = "https://host.example.com";
    const replay = buildReplayEnv(
      { CADET_PLATFORM_URL: "https://stale.example.com" },
      "gateway",
    );
    expect(replay).toEqual({});
  });

  test("gateway: captured CADET_PLATFORM_URL kept when unset on host", () => {
    delete process.env.CADET_PLATFORM_URL;
    const replay = buildReplayEnv(
      { CADET_PLATFORM_URL: "https://stale.example.com" },
      "gateway",
    );
    expect(replay).toEqual({
      CADET_PLATFORM_URL: "https://stale.example.com",
    });
  });

  test("assistant: drops builder-computed extras, secrets, and PATH; keeps custom flags", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const captured = {
      CADET_ASSISTANT_NAME: "my-assistant",
      GATEWAY_INTERNAL_URL: "http://localhost:8080",
      GUARDIAN_BOOTSTRAP_SECRET: "s1",
      CES_SERVICE_TOKEN: "s2",
      ACTOR_TOKEN_SIGNING_KEY: "s3",
      PATH: "/usr/bin",
      MY_CUSTOM_FLAG: "yes",
      ANTHROPIC_API_KEY: "sk-captured",
    };

    expect(buildReplayEnv(captured, "assistant")).toEqual({
      MY_CUSTOM_FLAG: "yes",
      ANTHROPIC_API_KEY: "sk-captured",
    });
  });

  test("assistant: captured ANTHROPIC_API_KEY dropped when set on host", () => {
    process.env.ANTHROPIC_API_KEY = "sk-host";
    const replay = buildReplayEnv(
      { ANTHROPIC_API_KEY: "sk-captured", MY_CUSTOM_FLAG: "yes" },
      "assistant",
    );
    expect(replay).toEqual({ MY_CUSTOM_FLAG: "yes" });
  });

  test("a secret added to the spec is auto-excluded with no code change", () => {
    const spec: DockerStatefulSetSpec = {
      startOrder: ["gateway"],
      readiness: { endpoint: "/readyz", timeoutMs: 1, intervalMs: 1 },
      volumeClaimTemplates: [],
      containers: [
        {
          name: "gateway-sidecar",
          internalName: "gateway",
          network: "container",
          env: [
            { kind: "secret", name: "FUTURE_SECRET", secret: "signingKey" },
          ],
          volumeMounts: [],
        },
      ],
    };

    const replay = buildReplayEnv(
      { FUTURE_SECRET: "leaky", CADET_DEVICE_ID: "abc" },
      "gateway",
      spec,
    );
    expect(replay).toEqual({ CADET_DEVICE_ID: "abc" });
  });
});

describe("buildReplayState", () => {
  beforeEach(() => {
    // CADET_DEVICE_ID env precedence keeps getOrCreateHostDeviceId off the
    // filesystem in tests.
    process.env.CADET_DEVICE_ID = "host-device-id";
    resetHostDeviceIdCache();
  });

  test("backfills CADET_DEVICE_ID on gateway replay env when absent", () => {
    const state = buildReplayState({}, { CADET_DISABLE_PLATFORM: "1" });
    expect(state.extraGatewayEnv).toEqual({
      CADET_DISABLE_PLATFORM: "1",
      CADET_DEVICE_ID: "host-device-id",
    });
  });

  test("captured CADET_DEVICE_ID wins over host-derived id", () => {
    const state = buildReplayState({}, { CADET_DEVICE_ID: "existing" });
    expect(state.extraGatewayEnv.CADET_DEVICE_ID).toBe("existing");
  });

  test("backfills CADET_DEVICE_ID on assistant replay env when absent", () => {
    const state = buildReplayState({}, {});
    expect(state.extraAssistantEnv.CADET_DEVICE_ID).toBe("host-device-id");
  });

  test("assistant backfill inherits captured gateway CADET_DEVICE_ID", () => {
    const state = buildReplayState({}, { CADET_DEVICE_ID: "gw-captured" });
    expect(state.extraGatewayEnv.CADET_DEVICE_ID).toBe("gw-captured");
    expect(state.extraAssistantEnv.CADET_DEVICE_ID).toBe("gw-captured");
  });

  test("captured assistant CADET_DEVICE_ID wins over host-derived id", () => {
    const state = buildReplayState({ CADET_DEVICE_ID: "existing" }, {});
    expect(state.extraAssistantEnv.CADET_DEVICE_ID).toBe("existing");
  });

  test("plucks secrets from the captured envs", () => {
    const state = buildReplayState(
      { CES_SERVICE_TOKEN: "ces-token", ACTOR_TOKEN_SIGNING_KEY: "sign-key" },
      { GUARDIAN_BOOTSTRAP_SECRET: "bootstrap" },
    );
    expect(state.bootstrapSecret).toBe("bootstrap");
    expect(state.cesServiceToken).toBe("ces-token");
    expect(state.signingKey).toBe("sign-key");
  });

  test("generates fresh secrets when missing from captured env", () => {
    const state = buildReplayState({}, {});
    expect(state.bootstrapSecret).toBeUndefined();
    expect(state.cesServiceToken).toMatch(/^[0-9a-f]{64}$/);
    expect(state.signingKey).toMatch(/^[0-9a-f]{64}$/);
  });
});
