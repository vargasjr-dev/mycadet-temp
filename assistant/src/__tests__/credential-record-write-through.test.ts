import { afterEach, describe, expect, test } from "bun:test";

import { credentialKey } from "@mycadet/credential-storage";

import { cesRecordBackend } from "../security/ces-rpc-record-backend.js";
import {
  CredentialCatalogUnavailableError,
  getCredentialMetadata,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";
import { startTestCesRecordServer } from "./helpers/test-ces-record-server.js";

const session = startTestCesRecordServer();

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
    const created = await upsertCredentialMetadata(
      "slack_channel",
      "bot_token",
      {
        allowedTools: ["bash"],
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stored = session.records.get(
      credentialKey("slack_channel", "bot_token"),
    );
    expect(stored?.allowedTools).toEqual(["bash"]);
    expect(stored?.credentialId).toBe(created.credentialId);
  });

  test("a write that fails raises CredentialCatalogUnavailableError", async () => {
    session.failSet = true;
    let caught: unknown;
    try {
      await upsertCredentialMetadata("slack_channel", "bot_token", {
        allowedTools: ["bash"],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CredentialCatalogUnavailableError);
    // Nothing reached the catalog, and the cache still holds the record (the
    // in-process view is optimistic; the durable state was never written).
    expect(session.records.size).toBe(0);
    expect(
      getCredentialMetadata("slack_channel", "bot_token"),
    ).toBeDefined();
  });
});
