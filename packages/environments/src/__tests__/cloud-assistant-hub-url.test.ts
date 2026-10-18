/**
 * Pins the environment-to-cloud-hub mapping in one place. Both consumers
 * (the Capacitor shell's `server.url` and the CLI remote-web edge's
 * `hubUrl`) read this helper, so this matrix is the single behavioral pin
 * for the served URLs. (The remote-web edge additionally folds local → dev
 * at its own site: clients served through a tunnel cannot reach the local
 * seed's loopback.)
 */

import { describe, expect, test } from "bun:test";

import { cloudAssistantHubUrl, SEEDS } from "../index.js";

describe("cloudAssistantHubUrl", () => {
  test("every known environment resolves to its own web origin", () => {
    for (const name of ["production", "staging", "dev", "test", "local"]) {
      expect(cloudAssistantHubUrl(name)).toBe(
        `${SEEDS[name].webUrl}/assistant`,
      );
    }
  });

  test("unknown environments fall back to the dev SPA", () => {
    for (const name of ["unknown-env", undefined]) {
      expect(cloudAssistantHubUrl(name)).toBe(
        "https://dev.mycadet.ai/assistant",
      );
    }
  });
});
