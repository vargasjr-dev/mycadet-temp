import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { startTestCesRecordServer } from "@mycadet/ces-client/test-support";

import { cesRecordBackend } from "../security/ces-rpc-record-backend.js";
import {
  _resetBackend,
  deleteSecureKeyAsync,
  getActiveBackendName,
  getSecureKeyAsync,
  getSecureKeyResultAsync,
  listSecureKeysAsync,
  setSecureKeyAsync,
  setSecureKeyBackendForTesting,
} from "../security/secure-keys.js";
import { useMemorySecureKeys } from "./helpers/secure-keys.js";

// The test server IS the CES sibling. Tests whose premise is "no CES
// reachable" stop it; tests that need a live backend restart it.
const session = startTestCesRecordServer();

describe("secure-keys", () => {
  let memoryKeys: Record<string, string>;

  beforeEach(() => {
    _resetBackend();
  });

  afterEach(async () => {
    await cesRecordBackend.close().catch(() => {});
    session.secrets.clear();
    session.records.clear();
    session.failSet = false;
    session.failList = false;
    if (!session.listening) {
      await session.start();
    }
    _resetBackend();
    // Clear any memory-backend pin a describe installed.
    setSecureKeyBackendForTesting(undefined);
    delete process.env.IS_CONTAINERIZED;
    delete process.env.CES_CREDENTIAL_URL;
  });

  // -----------------------------------------------------------------------
  // CRUD operations (through the pinned backend)
  // -----------------------------------------------------------------------
  describe("CRUD with the pinned backend", () => {
    beforeEach(() => {
      memoryKeys = useMemorySecureKeys();
    });

    test("set and get a key", async () => {
      await setSecureKeyAsync("openai", "sk-openai-789");
      expect(await getSecureKeyAsync("openai")).toBe("sk-openai-789");
    });

    test("get returns undefined for nonexistent key", async () => {
      expect(await getSecureKeyAsync("nonexistent")).toBeUndefined();
    });

    test("delete removes a key", async () => {
      await setSecureKeyAsync("gemini", "gem-key");
      expect(await deleteSecureKeyAsync("gemini")).toBe("deleted");
      expect(await getSecureKeyAsync("gemini")).toBeUndefined();
    });

    test("delete returns not-found for nonexistent key", async () => {
      expect(await deleteSecureKeyAsync("missing")).toBe("not-found");
    });
  });

  // -----------------------------------------------------------------------
  // No CES backend ready → unreachable, never absent
  // -----------------------------------------------------------------------
  describe("no CES backend ready", () => {
    beforeEach(async () => {
      await session.stop();
    });

    test("reads report unreachable (indeterminate)", async () => {
      _resetBackend();

      const result = await getSecureKeyResultAsync("openai");
      expect(result.value).toBeUndefined();
      // unreachable → presence indeterminate, NEVER absent.
      expect(result.unreachable).toBe(true);
      // Unreachable results are never cached — nothing is resolved.
      expect(getActiveBackendName()).toBe("none");
    });

    test("fails bounded when no CES socket is present", async () => {
      _resetBackend();

      const start = Date.now();
      await getSecureKeyAsync("openai");
      // The record backend's discovery polls ~3s to absorb a CES restart,
      // so the failure is bounded, not instant.
      expect(Date.now() - start).toBeLessThan(5_000);
      expect(getActiveBackendName()).toBe("none");
    });

    test("writes fail while unreachable", async () => {
      _resetBackend();

      const ok = await setSecureKeyAsync("api-key", "new-value");
      expect(ok).toBe(false);
    });

    test("delete reports an error while unreachable", async () => {
      _resetBackend();

      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("error");
    });

    test("list reports unreachable (empty accounts)", async () => {
      _resetBackend();

      const result = await listSecureKeysAsync();
      expect(result.unreachable).toBe(true);
      expect(result.accounts).toEqual([]);
    });

    test("a ready CES client wins the next read", async () => {
      _resetBackend();
      expect((await getSecureKeyResultAsync("openai")).unreachable).toBe(true);

      await session.start();
      await cesRecordBackend.close(); // fresh start: clear the failure cooldown
      await cesRecordBackend.ensureClient();

      const afterAttach = await getSecureKeyResultAsync("openai");
      expect(afterAttach.unreachable).toBe(false);
      expect(getActiveBackendName()).toBe("ces-rpc");
    });
  });

  // -----------------------------------------------------------------------
  // listSecureKeysAsync — single-backend key listing
  // -----------------------------------------------------------------------
  describe("listSecureKeysAsync", () => {
    beforeEach(() => {
      memoryKeys = useMemorySecureKeys();
    });

    test("returns the pinned backend's keys", async () => {
      memoryKeys["enc-key-1"] = "val1";
      memoryKeys["enc-key-2"] = "val2";

      const result = await listSecureKeysAsync();
      expect(result.unreachable).toBe(false);
      expect(result.accounts).toContain("enc-key-1");
      expect(result.accounts).toContain("enc-key-2");
      expect(result.accounts.length).toBe(2);
    });

    test("returns empty accounts when the store is empty", async () => {
      const result = await listSecureKeysAsync();
      expect(result).toEqual({ accounts: [], unreachable: false });
    });
  });

  // -----------------------------------------------------------------------
  // getSecureKeyResultAsync — richer result with unreachable flag
  // -----------------------------------------------------------------------
  describe("getSecureKeyResultAsync", () => {
    beforeEach(() => {
      memoryKeys = useMemorySecureKeys();
    });

    test("returns value and unreachable false on success", async () => {
      memoryKeys["api-key"] = "stored-value";

      const result = await getSecureKeyResultAsync("api-key");
      expect(result.value).toBe("stored-value");
      expect(result.unreachable).toBe(false);
    });

    test("returns unreachable false when key missing (backend reachable)", async () => {
      const result = await getSecureKeyResultAsync("missing-key");
      expect(result.value).toBeUndefined();
      expect(result.unreachable).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Containerized pod with no ready CES backend
  // -----------------------------------------------------------------------
  //
  // On a pod the local file store does not exist (and no process has one).
  // When no CES path is ready, reads must report the store as unreachable
  // (presence indeterminate) rather than absent. A provisioned credential
  // is never reported as "no key". The unreachable result must not pin
  // forever: once a CES client arrives, the next read routes through it.
  describe("containerized pod with no ready CES backend", () => {
    beforeEach(async () => {
      await session.stop();
    });

    test("reads report unreachable (indeterminate), never absent", async () => {
      process.env.IS_CONTAINERIZED = "1";
      delete process.env.CES_CREDENTIAL_URL;
      _resetBackend();

      const result = await getSecureKeyResultAsync("openai");
      expect(result.value).toBeUndefined();
      // unreachable → presence indeterminate, NEVER absent.
      expect(result.unreachable).toBe(true);
    });

    test("does not pin the unreachable result: a ready CES client wins the next read", async () => {
      process.env.IS_CONTAINERIZED = "1";
      delete process.env.CES_CREDENTIAL_URL;
      _resetBackend();

      expect((await getSecureKeyResultAsync("openai")).unreachable).toBe(true);

      // The record backend's session comes up (cooldown elapsed).
      await session.start();
      await cesRecordBackend.close(); // fresh start: clear the failure cooldown
      await cesRecordBackend.ensureClient();

      const afterAttach = await getSecureKeyResultAsync("openai");
      expect(afterAttach.unreachable).toBe(false);
      expect(getActiveBackendName()).toBe("ces-rpc");
    });
  });
});
