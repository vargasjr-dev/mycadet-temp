/**
 * Pins the environment-to-cloud-hub mapping in one place. Both consumers
 * (the Capacitor shell's `server.url` and the CLI remote-web edge's
 * `hubUrl`) read this helper, so this matrix is the single behavioral pin
 * for the served URLs. The helper reads `VITE_ENVIRONMENT` and
 * `CADET_ENVIRONMENT` itself — under bun `import.meta.env` surfaces the
 * process env live, so these cases drive both by setting/restoring them.
 * (The remote-web edge additionally folds local → dev at its own site:
 * clients served through a tunnel cannot reach the local seed's loopback.)
 */

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, test } from "bun:test";

import { cloudAssistantHubUrl, SEEDS } from "../index.js";

describe("cloudAssistantHubUrl", () => {
  const original = {
    vite: process.env.VITE_ENVIRONMENT,
    cadet: process.env.CADET_ENVIRONMENT,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("VITE_ENVIRONMENT picks its own web origin (the build-time inlined var)", () => {
    for (const name of ["production", "staging", "dev", "test", "local"]) {
      process.env.VITE_ENVIRONMENT = name;
      delete process.env.CADET_ENVIRONMENT;
      expect(cloudAssistantHubUrl()).toBe(`${SEEDS[name].webUrl}/assistant`);
    }
  });

  test("CADET_ENVIRONMENT picks its own web origin (the runtime var)", () => {
    for (const name of ["production", "staging", "dev", "test", "local"]) {
      process.env.CADET_ENVIRONMENT = name;
      delete process.env.VITE_ENVIRONMENT;
      expect(cloudAssistantHubUrl()).toBe(`${SEEDS[name].webUrl}/assistant`);
    }
  });

  test("CADET_ENVIRONMENT wins when both are set (the runtime contract)", () => {
    process.env.VITE_ENVIRONMENT = "production";
    process.env.CADET_ENVIRONMENT = "staging";
    expect(cloudAssistantHubUrl()).toBe(`${SEEDS.staging.webUrl}/assistant`);
  });

  test("unset and unknown environments fall back to the dev SPA", () => {
    for (const set of [
      () => {
        delete process.env.VITE_ENVIRONMENT;
        delete process.env.CADET_ENVIRONMENT;
      },
      () => {
        delete process.env.CADET_ENVIRONMENT;
        process.env.VITE_ENVIRONMENT = "unknown-env";
      },
    ]) {
      set();
      expect(cloudAssistantHubUrl()).toBe("https://dev.mycadet.ai/assistant");
    }
  });
});

test("seeds.ts stays loadable by Capacitor's single-file TS config loader", () => {
  // The loader transpiles the file to CJS; an import-meta reference can't be
  // transpiled and makes Node execute the CJS output as ESM (`exports is not
  // defined`), which took down the iOS Capacitor sync in CI.
  const src = readFileSync(new URL("../seeds.ts", import.meta.url), "utf8");
  expect(src).not.toContain("import.meta");
});
