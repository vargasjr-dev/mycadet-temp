import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { startTestCesRecordServer } from "@mycadet/ces-client/test-support";
import { credentialKey } from "@mycadet/credential-storage";
import type { CredentialRecord } from "@mycadet/service-contracts/credential-rpc";

import { cesRecordBackend } from "../security/ces-rpc-record-backend.js";
import {
  _ensureCesRecordsLoaded,
  _resetCredentialMetadataCacheForTests,
  getCredentialMetadata,
  listCredentialRecordsLive,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";
import { getDataDir } from "../util/layout.js";

const session = startTestCesRecordServer();

function leftoverPath(): string {
  return join(getDataDir(), "credentials", "metadata.json");
}

function writeLeftover(record: CredentialRecord): void {
  const path = leftoverPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 5,
      credentials: [record],
    }),
  );
}

function leftoverContents(): string {
  return readFileSync(leftoverPath(), "utf-8");
}

function seedStore(record: Partial<CredentialRecord>): CredentialRecord {
  const full: CredentialRecord = {
    credentialId: "cred-1",
    service: "github",
    field: "token",
    allowedTools: ["bash"],
    allowedDomains: [],
    createdAt: 1,
    updatedAt: 2,
    ...record,
  };
  session.records.set(credentialKey(full.service, full.field), full);
  return full;
}

describe("CES credential record cache", () => {
  beforeEach(() => {
    _resetCredentialMetadataCacheForTests();
    const leftover = leftoverPath();
    if (existsSync(leftover)) {
      rmSync(leftover, { force: true });
    }
  });

  afterEach(async () => {
    await cesRecordBackend.close();
    _resetCredentialMetadataCacheForTests();
    session.records.clear();
    session.failList = false;
    session.failSet = false;
    if (!session.listening) {
      await session.start();
    }
    const leftover = leftoverPath();
    if (existsSync(leftover)) {
      rmSync(leftover, { force: true });
    }
  });

  test("first catalog read lazy-loads CES records into the in-process cache", async () => {
    seedStore({});
    const listCallsBefore = session.calls.filter(
      (call) => call.method === "list_credential_records",
    ).length;

    getCredentialMetadata("github", "token");
    await _ensureCesRecordsLoaded();

    expect(getCredentialMetadata("github", "token")?.credentialId).toBe(
      "cred-1",
    );
    expect(getCredentialMetadata("github", "token")?.allowedTools).toEqual([
      "bash",
    ]);
    getCredentialMetadata("github", "token");
    await _ensureCesRecordsLoaded();
    const listCallsAfter = session.calls.filter(
      (call) => call.method === "list_credential_records",
    ).length;
    // The load is single-flight: a second read does not re-list.
    expect(listCallsAfter).toBe(listCallsBefore + 1);
  });

  test("lazy load leaves leftover metadata.json in place and ignores it", async () => {
    const leftoverRecord: CredentialRecord = {
      credentialId: "cred-leftover",
      service: "github",
      field: "token",
      allowedTools: ["bash"],
      allowedDomains: ["github.com"],
      createdAt: 1,
      updatedAt: 2,
    };
    writeLeftover(leftoverRecord);
    const before = leftoverContents();

    seedStore({
      credentialId: "cred-leftover",
      allowedDomains: ["github.com"],
    });

    getCredentialMetadata("github", "token");
    await _ensureCesRecordsLoaded();

    expect(existsSync(leftoverPath())).toBe(true);
    expect(leftoverContents()).toBe(before);
    expect(getCredentialMetadata("github", "token")?.allowedTools).toEqual([
      "bash",
    ]);
  });

  test("lazy load ignores leftover metadata.json when CES list fails", async () => {
    const leftoverRecord: CredentialRecord = {
      credentialId: "cred-keep",
      service: "slack_channel",
      field: "bot_token",
      allowedTools: ["bash"],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 2,
    };
    writeLeftover(leftoverRecord);

    session.failList = true;

    getCredentialMetadata("slack_channel", "bot_token");
    await _ensureCesRecordsLoaded();

    expect(existsSync(leftoverPath())).toBe(true);
    expect(getCredentialMetadata("slack_channel", "bot_token")).toBeUndefined();
  });

  test("lazy load ignores leftover metadata.json when CES has no leftover accounts", async () => {
    const leftoverRecord: CredentialRecord = {
      credentialId: "cred-missing",
      service: "github",
      field: "token",
      allowedTools: ["bash"],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 2,
    };
    writeLeftover(leftoverRecord);

    getCredentialMetadata("github", "token");
    await _ensureCesRecordsLoaded();

    expect(existsSync(leftoverPath())).toBe(true);
    expect(session.records.size).toBe(0);
    expect(getCredentialMetadata("github", "token")).toBeUndefined();
  });

  test("live catalog list returns CES records without the in-process cache", async () => {
    seedStore({ credentialId: "cred-live" });

    const live = await listCredentialRecordsLive();
    expect(live.unreachable).toBe(false);
    expect(live.records).toHaveLength(1);
    expect(live.records[0]?.credentialId).toBe("cred-live");
    expect(getCredentialMetadata("github", "token")).toBeUndefined();
  });

  test("live catalog list reports unreachable when CES list fails", async () => {
    session.failList = true;

    const live = await listCredentialRecordsLive();
    expect(live.unreachable).toBe(true);
    expect(live.records).toEqual([]);
  });

  test("live catalog list reports unreachable when the session cannot open", async () => {
    await session.stop();
    await cesRecordBackend.close();
    _resetCredentialMetadataCacheForTests();

    const live = await listCredentialRecordsLive();
    expect(live.unreachable).toBe(true);
    expect(live.records).toEqual([]);
  });

  test("live catalog list does not fail over when CES returns an empty catalog", async () => {
    const live = await listCredentialRecordsLive();
    expect(live.unreachable).toBe(false);
    expect(live.records).toEqual([]);
  });

  test("upsert write-throughs to CES without updating leftover metadata.json", async () => {
    const leftoverRecord: CredentialRecord = {
      credentialId: "cred-leftover",
      service: "github",
      field: "token",
      allowedTools: ["bash"],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 2,
    };
    writeLeftover(leftoverRecord);
    const leftoverBefore = leftoverContents();

    seedStore({});
    getCredentialMetadata("github", "token");
    await _ensureCesRecordsLoaded();
    await cesRecordBackend.ensureClient();
    expect(existsSync(leftoverPath())).toBe(true);

    const created = await upsertCredentialMetadata(
      "slack_channel",
      "bot_token",
      {
        allowedTools: ["bash"],
      },
    );
    await cesRecordBackend.ensureClient();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(existsSync(leftoverPath())).toBe(true);
    expect(leftoverContents()).toBe(leftoverBefore);
    expect(
      session.records.get(credentialKey("slack_channel", "bot_token"))
        ?.credentialId,
    ).toBe(created.credentialId);
    expect(
      getCredentialMetadata("slack_channel", "bot_token")?.allowedTools,
    ).toEqual(["bash"]);
  });
});
