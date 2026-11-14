import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock logger (no-op — compatible with other test files' identical mock)
// ---------------------------------------------------------------------------
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
import { installMockCesRecordSession } from "./helpers/mock-ces-record-session.js";
import { useMemorySecureKeys } from "./helpers/secure-keys.js";

// Hermetic by default: openCesRpcSession fails, so "no CES reachable" tests
// never see a session. Tests that need a live backend flip failSession off.
const session = installMockCesRecordSession();
session.failSession = true;

describe("secure-keys", () => {
  let memoryKeys: Record<string, string>;
  const socketDirs: string[] = [];

  /**
   * Point CES discovery at an empty temp dir so tests whose premise is "no
   * CES sibling is reachable" never find this machine's live bootstrap
   * socket (/run/ces-bootstrap).
   */
  function useEmptyCesSocketDir(): void {
    const dir = mkdtempSync(join(tmpdir(), "no-ces-socket-"));
    process.env.CES_BOOTSTRAP_SOCKET_DIR = dir;
    socketDirs.push(dir);
  }

  beforeEach(() => {
    _resetBackend();
  });

  afterEach(async () => {
    await cesRecordBackend.close().catch(() => {});
    session.store.clear();
    session.failSession = true;
    session.setClientReady(true);
    _resetBackend();
    // Clear any memory-backend pin a describe installed.
    setSecureKeyBackendForTesting(undefined);
    delete process.env.IS_CONTAINERIZED;
    delete process.env.CES_CREDENTIAL_URL;
    delete process.env.CES_BOOTSTRAP_SOCKET_DIR;
    while (socketDirs.length) {
      rmSync(socketDirs.pop()!, { recursive: true, force: true });
    }
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
    beforeEach(() => {
      useEmptyCesSocketDir();
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

    test("does not poll for a CES socket when none is present", async () => {
      _resetBackend();

      const start = Date.now();
      await getSecureKeyAsync("openai");
      expect(Date.now() - start).toBeLessThan(1_000);
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

      session.failSession = false;
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
    beforeEach(() => {
      useEmptyCesSocketDir();
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
      session.failSession = false;
      await cesRecordBackend.ensureClient();

      const afterAttach = await getSecureKeyResultAsync("openai");
      expect(afterAttach.unreachable).toBe(false);
      expect(getActiveBackendName()).toBe("ces-rpc");
    });
  });
});
