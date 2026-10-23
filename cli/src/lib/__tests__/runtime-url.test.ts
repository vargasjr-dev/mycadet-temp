import { describe, expect, test } from "bun:test";

import type { LockfileAssistant } from "../assistant-config.js";
import { resolveRuntimeUrl } from "../runtime-url.js";

function makeEntry(
  overrides: Partial<LockfileAssistant> & {
    cloud: string;
    runtimeUrl: string;
    assistantId: string;
  },
): Pick<LockfileAssistant, "cloud" | "runtimeUrl" | "assistantId"> {
  return {
    cloud: overrides.cloud,
    runtimeUrl: overrides.runtimeUrl,
    assistantId: overrides.assistantId,
  };
}

describe("resolveRuntimeUrl", () => {
  test("local cloud uses gateway-loopback /v1/<subpath>", () => {
    const entry = makeEntry({
      cloud: "local",
      runtimeUrl: "http://localhost:7821",
      assistantId: "ast-local-1",
    });
    expect(resolveRuntimeUrl(entry, "identity")).toBe(
      "http://localhost:7821/v1/identity",
    );
  });

  test("docker cloud uses gateway-loopback /v1/<subpath>", () => {
    const entry = makeEntry({
      cloud: "docker",
      runtimeUrl: "http://localhost:7831",
      assistantId: "ast-docker-1",
    });
    expect(resolveRuntimeUrl(entry, "identity")).toBe(
      "http://localhost:7831/v1/identity",
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
