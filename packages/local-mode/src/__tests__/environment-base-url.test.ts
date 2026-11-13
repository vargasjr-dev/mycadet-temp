/**
 * Pins the environment-to-origin mapping and the `CADET_CLOUD_URL`
 * override in one place. The helper reads `VITE_ENVIRONMENT` and
 * `CADET_ENVIRONMENT` itself — these cases drive both by setting and
 * restoring them.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { getCloudBaseUrl, SEEDS } from "@mycadet/shared";

describe("getCloudBaseUrl", () => {
  const original = {
    vite: process.env.VITE_ENVIRONMENT,
    env: process.env.CADET_ENVIRONMENT,
    cloud: process.env.CADET_CLOUD_URL,
  };

  const restoreEnv = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  afterEach(() => {
    restoreEnv("VITE_ENVIRONMENT", original.vite);
    restoreEnv("CADET_ENVIRONMENT", original.env);
    restoreEnv("CADET_CLOUD_URL", original.cloud);
  });

  test("VITE_ENVIRONMENT picks its own origin (the build-time inlined var)", () => {
    for (const name of ["production", "staging", "dev", "test", "local"]) {
      process.env.VITE_ENVIRONMENT = name;
      delete process.env.CADET_ENVIRONMENT;
      expect(getCloudBaseUrl()).toBe(SEEDS[name].baseUrl);
    }
  });

  test("CADET_ENVIRONMENT picks its own origin (the runtime var)", () => {
    for (const name of ["production", "staging", "dev", "test", "local"]) {
      process.env.CADET_ENVIRONMENT = name;
      delete process.env.VITE_ENVIRONMENT;
      expect(getCloudBaseUrl()).toBe(SEEDS[name].baseUrl);
    }
  });

  test("an unknown environment falls back to dev", () => {
    process.env.CADET_ENVIRONMENT = "not-a-seed";
    expect(getCloudBaseUrl()).toBe(SEEDS.dev.baseUrl);
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

  test("an unset environment falls back to dev", () => {
    delete process.env.CADET_ENVIRONMENT;
    delete process.env.VITE_ENVIRONMENT;
    expect(getCloudBaseUrl()).toBe(SEEDS.dev.baseUrl);
  });
});
