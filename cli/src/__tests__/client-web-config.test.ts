/**
 * Tests for the config `cadet client --interface web` serves at
 * `/assistant/__config`, the document a caller probes to learn which assistant
 * an origin fronts. This host also serves the `__local` endpoints, so its SPA
 * switches between every assistant in the lockfile and the origin has no single
 * identity to report: the config must stay free of an `assistantId`, matching
 * the Vite dev server's local-mode plugin.
 */
import { describe, expect, test } from "bun:test";

import { buildWebInterfaceConfig } from "../commands/client.js";

const BASE = {
  webUrl: "https://app.example.com",
  cloudUrl: "https://platform.example.com",
};

describe("cadet client web __config", () => {
  test("reports no assistant identity for the multi-assistant origin", () => {
    const config = buildWebInterfaceConfig(BASE);

    expect(config).toEqual(BASE);
    // A stamped id would be the launch-time one, so a probe for any other
    // assistant this origin serves would read a false `foreign`.
    expect(config).not.toHaveProperty("assistantId");
  });

  test("carries the serving version when the caller stamps one", () => {
    const config = buildWebInterfaceConfig({
      ...BASE,
      version: "0.13.0-local.202610191920.58bcf38",
    });

    expect(config["version"]).toBe("0.13.0-local.202610191920.58bcf38");
    expect(config).not.toHaveProperty("assistantId");
  });
});
