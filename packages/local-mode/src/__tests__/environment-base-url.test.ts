/**
 * Pins the environment-to-origin mapping and the `CADET_CLOUD_URL`
 * override in one place. The helper reads `VITE_ENVIRONMENT` and
 * `CADET_ENVIRONMENT` itself — these cases drive both by setting and
 * restoring them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getCloudBaseUrl, SEEDS } from "@mycadet/shared";

describe("getCloudBaseUrl", () => {
  const original = {
    vite: process.env.VITE_ENVIRONMENT,
    env: process.env.CADET_ENVIRONMENT,
    cloud: process.env.CADET_CLOUD_URL,
    xdg: process.env.XDG_CONFIG_HOME,
    version: (globalThis as { __CADET_OWN_VERSION__?: string })
      .__CADET_OWN_VERSION__,
  };

  const restoreEnv = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  let configHome: string;

  // The persisted-default arm reads the config home; pin it to a temp dir so
  // this file never consults the real ~/.config. The version global is
  // pinned to a plain version so the channel arm stays silent and the
  // fallback expectations below are deterministic.
  beforeEach(() => {
    configHome = mkdtempSync(path.join(os.tmpdir(), "cadet-cloud-url-"));
    process.env.XDG_CONFIG_HOME = configHome;
    (globalThis as { __CADET_OWN_VERSION__?: string }).__CADET_OWN_VERSION__ =
      "0.0.1";
  });

  afterEach(() => {
    rmSync(configHome, { recursive: true, force: true });
    restoreEnv("VITE_ENVIRONMENT", original.vite);
    restoreEnv("CADET_ENVIRONMENT", original.env);
    restoreEnv("CADET_CLOUD_URL", original.cloud);
    restoreEnv("XDG_CONFIG_HOME", original.xdg);
    (globalThis as { __CADET_OWN_VERSION__?: string }).__CADET_OWN_VERSION__ =
      original.version;
  });

  test("VITE_ENVIRONMENT picks its own origin (the build-time inlined var)", () => {
    for (const name of [
      "production",
      "staging",
      "dev",
      "test",
      "local",
    ] as const) {
      process.env.VITE_ENVIRONMENT = name;
      delete process.env.CADET_ENVIRONMENT;
      expect(getCloudBaseUrl()).toBe(SEEDS[name].baseUrl);
    }
  });

  test("CADET_ENVIRONMENT picks its own origin (the runtime var)", () => {
    for (const name of [
      "production",
      "staging",
      "dev",
      "test",
      "local",
    ] as const) {
      process.env.CADET_ENVIRONMENT = name;
      delete process.env.VITE_ENVIRONMENT;
      expect(getCloudBaseUrl()).toBe(SEEDS[name].baseUrl);
    }
  });

  test("an unknown environment falls through to production", () => {
    process.env.CADET_ENVIRONMENT = "not-a-seed";
    expect(getCloudBaseUrl()).toBe(SEEDS.production.baseUrl);
  });

  test("the explicit CADET_CLOUD_URL override wins", () => {
    process.env.CADET_CLOUD_URL = "https://override.example";
    process.env.CADET_ENVIRONMENT = "dev";
    expect(getCloudBaseUrl()).toBe("https://override.example");
  });

  test("trims whitespace from CADET_CLOUD_URL", () => {
    process.env.CADET_CLOUD_URL = "  https://trimmed.example  ";
    expect(getCloudBaseUrl()).toBe("https://trimmed.example");
  });

  test("an unset environment resolves production", () => {
    delete process.env.CADET_ENVIRONMENT;
    delete process.env.VITE_ENVIRONMENT;
    expect(getCloudBaseUrl()).toBe(SEEDS.production.baseUrl);
  });
});
