import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveLockfileAssistant } from "@mycadet/local-mode";

import { AssistantClient } from "../lib/assistant-client.js";
import { withPreconnect } from "./helpers/http.js";

const testDir = mkdtempSync(join(tmpdir(), "client-asleep-test-"));
const ORIGINAL_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_FETCH = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = ORIGINAL_CONFIG_HOME;
  rmSync(testDir, { recursive: true, force: true });
});

test("a request to a sleeping assistant says to wake it", async () => {
  process.env.XDG_CONFIG_HOME = testDir;
  // No gateway.pid in the instance dir, so the gateway isn't running.
  saveLockfileAssistant({
    assistantId: "nap",
    cloud: "local",
    instanceDir: join(testDir, "instance"),
  });
  globalThis.fetch = withPreconnect(async () => {
    throw new Error(
      "Unable to connect. Is the computer able to access the url?",
    );
  });

  const client = new AssistantClient({ assistantId: "nap" });
  await expect(client.post("/messages/", { content: "hi" })).rejects.toThrow(
    "nap is asleep. Run `cadet wake nap` first.",
  );
});
