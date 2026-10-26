import { describe, expect, test } from "bun:test";

import { resolveRuntimeUrl } from "../runtime-url.js";
import { makeEntry } from "../../__tests__/helpers/lockfile-entry.js";

describe("resolveRuntimeUrl", () => {
  test("local cloud uses gateway-loopback /v1/<subpath>", () => {
    const entry = makeEntry({
      cloud: "local",
      resources: { gatewayPort: 7821, daemonPort: 7822 },
      assistantId: "ast-local-1",
    });
    expect(resolveRuntimeUrl(entry, "identity")).toBe(
      "http://127.0.0.1:7821/v1/identity",
    );
  });

  test("docker cloud uses gateway-loopback /v1/<subpath>", () => {
    const entry = makeEntry({
      cloud: "docker",
      resources: { gatewayPort: 7831, daemonPort: 7821 },
      assistantId: "ast-docker-1",
    });
    expect(resolveRuntimeUrl(entry, "identity")).toBe(
      "http://127.0.0.1:7831/v1/identity",
    );
  });

  test("cloud home uses wildcard-proxy /v1/assistants/<id>/<subpath>", () => {
    const entry = makeEntry({
      cloud: "cloud",
      runtimeUrl: "https://cloud.mycadet.ai",
      assistantId: "11111111-2222-3333-4444-555555555555",
    });
    expect(resolveRuntimeUrl(entry, "identity")).toBe(
      "https://cloud.mycadet.ai/v1/assistants/11111111-2222-3333-4444-555555555555/identity",
    );
  });
});
