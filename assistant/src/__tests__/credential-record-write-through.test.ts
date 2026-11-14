import { afterEach, describe, expect, test } from "bun:test";

import { credentialKey } from "@mycadet/credential-storage";

import { cesRecordBackend } from "../security/ces-rpc-record-backend.js";

const session = startTestCesRecordServer();
import { upsertCredentialMetadata } from "../tools/credentials/metadata-store.js";
import { startTestCesRecordServer } from "./helpers/test-ces-record-server.js";

describe("CES credential record write-through", () => {
  afterEach(async () => {
    session.secrets.clear();
    session.records.clear();
    session.failSet = false;
    if (!session.listening) {
      await session.start();
    }
    await cesRecordBackend.close();
  });

  test("upsert write-through updates the CES backend", async () => {
    const created = upsertCredentialMetadata("slack_channel", "bot_token", {
      allowedTools: ["bash"],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stored = session.records.get(
      credentialKey("slack_channel", "bot_token"),
    );
    expect(stored?.allowedTools).toEqual(["bash"]);
    expect(stored?.credentialId).toBe(created.credentialId);
  });

  test("a write that fails is queued and retried on the next flush", async () => {
    session.failSet = true;
    upsertCredentialMetadata("slack_channel", "bot_token", {
      allowedTools: ["bash"],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(session.records.size).toBe(0);

    session.failSet = false;
    upsertCredentialMetadata("slack_channel", "bot_token", {
      allowedTools: ["bash"],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      session.records.get(credentialKey("slack_channel", "bot_token"))
        ?.allowedTools,
    ).toEqual(["bash"]);
  });
});
