import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { resolveRuntimeUrl } from "../runtime-url.js";
import {
  makeEntry,
  readEntry,
} from "../../__tests__/helpers/lockfile-entry.js";

// The fixture helper writes through the real lockfile path — isolate it.
const testDir = mkdtempSync(join(tmpdir(), "runtime-url-test-"));
const prevConfigHome = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = testDir;
afterAll(() => {
  if (prevConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevConfigHome;
});

describe("resolveRuntimeUrl", () => {
  test("local cloud uses gateway-loopback /v1/<subpath>", () => {
    makeEntry({
      cloud: "local",
      resources: { gatewayPort: 7821, daemonPort: 7822 },
      assistantId: "ast-local-1",
    });
    const entry = readEntry("ast-local-1")!;
    expect(resolveRuntimeUrl(entry, "identity")).toBe(
      "http://127.0.0.1:7821/v1/identity",
    );
  });

  test("docker cloud uses gateway-loopback /v1/<subpath>", () => {
    makeEntry({
      cloud: "docker",
      resources: { gatewayPort: 7831, daemonPort: 7821 },
      assistantId: "ast-docker-1",
    });
    const entry = readEntry("ast-docker-1")!;
    expect(resolveRuntimeUrl(entry, "identity")).toBe(
      "http://127.0.0.1:7831/v1/identity",
    );
  });

  test("cloud home uses wildcard-proxy /v1/assistants/<id>/<subpath>", () => {
    makeEntry({
      cloud: "cloud",
      assistantId: "11111111-2222-3333-4444-555555555555",
    });
    const entry = readEntry("11111111-2222-3333-4444-555555555555")!;
    expect(resolveRuntimeUrl(entry, "identity")).toBe(
      "https://cloud.mycadet.ai/v1/assistants/11111111-2222-3333-4444-555555555555/identity",
    );
  });
});
