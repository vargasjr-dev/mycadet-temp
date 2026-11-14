import { afterEach, describe, expect, test } from "bun:test";

import { credentialKey } from "@mycadet/credential-storage";

import { cesRecordBackend } from "../security/ces-rpc-record-backend.js";
import { upsertCredentialMetadata } from "../tools/credentials/metadata-store.js";
import { installMockCesRecordSession } from "./helpers/mock-ces-record-session.js";

const session = installMockCesRecordSession();

describe("CES credential record write-through", () => {
  afterEach(async () => {
    session.store.clear();
    session.failSet = false;
    await cesRecordBackend.close();
  });

  test("upsert write-through updates the CES backend", async () => {
    const created = upsertCredentialMetadata("slack_channel", "bot_token", {
      allowedTools: ["bash"],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stored = session.store.get(
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
    await cesRecordBackend.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(session.store.size).toBe(0);

    session.failSet = false;
    upsertCredentialMetadata("slack_channel", "bot_token", {
      allowedTools: ["bash"],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      session.store.get(credentialKey("slack_channel", "bot_token"))
        ?.allowedTools,
    ).toEqual(["bash"]);
  });
});
