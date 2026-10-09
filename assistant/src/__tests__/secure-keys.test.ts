import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveIpcEndpoint } from "@mycadet/ipc-server-utils";

// ---------------------------------------------------------------------------
// Mock logger (no-op — compatible with other test files' identical mock)
// ---------------------------------------------------------------------------
import type { CesClient } from "../credential-execution/client.js";
import {
  _resetBackend,
  deleteSecureKeyAsync,
  getActiveBackendName,
  getSecureKeyAsync,
  getSecureKeyResultAsync,
  listSecureKeysAsync,
  setCesClient,
  setCesReconnect,
  setSecureKeyAsync,
  setSecureKeyBackendForTesting,
} from "../security/secure-keys.js";
import { useMemorySecureKeys } from "./helpers/secure-keys.js";

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

    // Ensure CADET_DEV and CADET_DESKTOP_APP are NOT set
    delete process.env.CADET_DEV;
    delete process.env.CADET_DESKTOP_APP;
  });

  afterEach(() => {
    _resetBackend();
    // Clear any memory-backend pin a describe installed.
    setSecureKeyBackendForTesting(undefined);
    delete process.env.CADET_DEV;
    delete process.env.CADET_DESKTOP_APP;
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
      expect(getActiveBackendName()).toBe("unavailable");
    });

    test("does not poll for a CES socket when none is present", async () => {
      _resetBackend();

      const start = Date.now();
      await getSecureKeyAsync("openai");
      expect(Date.now() - start).toBeLessThan(1_000);
      expect(getActiveBackendName()).toBe("unavailable");
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

      const client = makeMockCesClient(true);
      setCesClient(client);

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
  // Mock CES client — shared by the reconnection test suites below
  // -----------------------------------------------------------------------

  interface MockCesClient extends CesClient {
    setReady: (ready: boolean) => void;
    /** Credential writes received via `call`, in order. */
    sets: Array<{ account: string; value: string }>;
  }

  function makeMockCesClient(initialReady = true): MockCesClient {
    let ready = initialReady;
    const sets: Array<{ account: string; value: string }> = [];
    return {
      handshake: async () => ({ accepted: true }),
      call: async (_method: unknown, params: unknown) => {
        const p = params as { account?: string; value?: string };
        if (typeof p?.account === "string" && typeof p?.value === "string") {
          sets.push({ account: p.account, value: p.value });
        }
        return { ok: true, found: false, value: undefined } as never;
      },
      isReady: () => ready,
      close: () => {
        ready = false;
      },
      updateAssistantApiKey: async () => ({ updated: true }),
      setReady: (r: boolean) => {
        ready = r;
      },
      sets,
    } as MockCesClient;
  }

  // -----------------------------------------------------------------------
  // CES reconnection reentrancy
  // -----------------------------------------------------------------------
  //
  // The reconnect callback runs while the credential resolver is waiting on
  // `_reconnectInFlight`. A nested `getSecureKeyAsync()` from inside the
  // callback — e.g. `resolveManagedProxyContext()` reading the assistant API
  // key for the handshake — would recursively `await` the same in-flight
  // promise and deadlock for 45 seconds until `CREDENTIAL_OP_TIMEOUT_MS`
  // fires. The guard in `attemptCesReconnection` short-circuits that
  // reentrant case so nested reads resolve immediately (as "unreachable")
  // and the outer reconnect makes progress.
  describe("reconnect callback reentrancy", () => {
    test("nested credential read inside reconnect callback does not deadlock", async () => {
      // Install a CES client that starts ready so the first read resolves
      // the backend to CES RPC, then flip it to unready so the NEXT read
      // triggers the reconnect path.
      const client = makeMockCesClient(true);
      setCesClient(client);

      // Prime the resolver so `_resolvedBackend` points at CES RPC.
      await getSecureKeyAsync("test-key");
      client.setReady(false);

      let nestedReadResolved = false;
      let reconnectCallbackRan = 0;

      setCesReconnect(async () => {
        reconnectCallbackRan++;
        // Yield once so `_reconnectInFlight` (assigned after this IIFE's
        // first await) is observable to any nested resolver. This matches
        // production timing, where the callback awaits `pm.stop()` /
        // `pm.start()` before reading credentials — those awaits complete
        // the outer assignment, so the subsequent nested read sees a live
        // `_reconnectInFlight` and is the recursion that caused the 45s
        // deadlock.
        await Promise.resolve();
        await getSecureKeyAsync("test-key");
        nestedReadResolved = true;
        return makeMockCesClient(true);
      });

      const start = Date.now();
      await getSecureKeyAsync("test-key");
      const elapsed = Date.now() - start;

      expect(reconnectCallbackRan).toBe(1);
      expect(nestedReadResolved).toBe(true);
      // Pre-fix, this took 45s (CREDENTIAL_OP_TIMEOUT_MS). Post-fix it's
      // bounded only by the mock callback's own work.
      expect(elapsed).toBeLessThan(2000);
    });

    test("reconnect callback that throws still releases the reentrancy flag", async () => {
      const client = makeMockCesClient(true);
      setCesClient(client);
      await getSecureKeyAsync("any-key"); // prime the resolver
      client.setReady(false);

      setCesReconnect(async () => {
        throw new Error("boom");
      });

      await getSecureKeyAsync("any-key");

      // Swap in a reconnect that succeeds and wait past the 3s cooldown
      // in `attemptCesReconnection`. A stuck reentrancy flag from the
      // throwing callback would prevent this second attempt from running.
      let secondCallbackRan = 0;
      setCesReconnect(async () => {
        secondCallbackRan++;
        return makeMockCesClient(true);
      });
      await new Promise((resolve) => setTimeout(resolve, 3_100));

      await getSecureKeyAsync("any-key");
      expect(secondCallbackRan).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Write ops bypass the reconnect cooldown
  // -----------------------------------------------------------------------
  //
  // Credential writes are rare and have no fallback: a set that fails
  // because a reconnect completed moments earlier is silently dropped by
  // callers (e.g. the post-login cloud credential push stores the
  // assistant API key exactly once). Writes therefore force a reconnection
  // attempt even inside the cooldown window, while reads keep respecting
  // the cooldown to avoid restart stampedes.
  describe("write ops bypass the reconnect cooldown", () => {
    /**
     * Resolve the backend to a CES client, kill it, and burn one
     * reconnection attempt (which fails) so the cooldown window is active.
     * Returns the number of reconnect callback runs via a counter ref.
     */
    async function enterCooldownWithDeadBackend(): Promise<{
      counter: { runs: number };
      setReconnectResult: (client: CesClient | undefined) => void;
    }> {
      const client = makeMockCesClient(true);
      setCesClient(client);
      await getSecureKeyAsync("prime-key");
      client.setReady(false);

      const counter = { runs: 0 };
      let reconnectResult: CesClient | undefined;
      setCesReconnect(async () => {
        counter.runs++;
        return reconnectResult;
      });

      // Trigger one failed reconnection attempt to stamp the cooldown.
      await getSecureKeyAsync("prime-key");

      return {
        counter,
        setReconnectResult: (c) => {
          reconnectResult = c;
        },
      };
    }

    test("set during the cooldown reconnects and stores on the fresh client", async () => {
      const { counter, setReconnectResult } =
        await enterCooldownWithDeadBackend();
      expect(counter.runs).toBe(1);

      const fresh = makeMockCesClient(true);
      setReconnectResult(fresh);

      const ok = await setSecureKeyAsync("credential/cadet/api_key", "sk-1");

      expect(ok).toBe(true);
      expect(counter.runs).toBe(2);
      expect(fresh.sets).toEqual([
        { account: "credential/cadet/api_key", value: "sk-1" },
      ]);
    });

    test("read during the cooldown does not trigger another reconnect", async () => {
      const { counter, setReconnectResult } =
        await enterCooldownWithDeadBackend();
      expect(counter.runs).toBe(1);

      setReconnectResult(makeMockCesClient(true));

      const result = await getSecureKeyResultAsync("prime-key");

      expect(counter.runs).toBe(1);
      expect(result.unreachable).toBe(true);
    });

    test("set during the cooldown upgrades from unreachable to CES", async () => {
      useEmptyCesSocketDir();
      // No CES client installed — the resolver reports unreachable (CES
      // failed at startup and there is no local fallback).
      await getSecureKeyAsync("prime-key");
      expect(getActiveBackendName()).toBe("unavailable");

      const fresh = makeMockCesClient(true);
      const counter = { runs: 0 };
      setCesReconnect(async () => {
        counter.runs++;
        // First attempt fails; later attempts hand back a live CES client.
        return counter.runs === 1 ? undefined : fresh;
      });

      // A read attempts the CES upgrade (and fails), stamping the cooldown.
      await getSecureKeyAsync("prime-key");
      expect(counter.runs).toBe(1);

      const ok = await setSecureKeyAsync("credential/cadet/api_key", "sk-2");

      expect(ok).toBe(true);
      expect(counter.runs).toBe(2);
      expect(fresh.sets).toEqual([
        { account: "credential/cadet/api_key", value: "sk-2" },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Unreachable → CES upgrade without a reconnect callback
  // -----------------------------------------------------------------------
  //
  // Worker/CLI processes inject a CES client whose handshake is still in
  // flight, so the first credential read reports unreachable. These
  // processes never register `_cesReconnect`. Once the handshake completes
  // and the client reports ready, the next read must upgrade to CES RPC,
  // since the live client already exists and no reconnect is needed.
  describe("unreachable → CES upgrade without a reconnect callback", () => {
    test("upgrades to CES RPC once the injected client becomes ready", async () => {
      const client = makeMockCesClient(false);
      setCesClient(client);

      // Not ready yet → unreachable (no local fallback exists).
      const before = await getSecureKeyResultAsync("openai");
      expect(before.unreachable).toBe(true);
      expect(getActiveBackendName()).toBe("unavailable");

      // Handshake completes; no `_cesReconnect` was ever registered.
      client.setReady(true);

      await getSecureKeyResultAsync("openai");
      expect(getActiveBackendName()).toBe("ces-rpc");
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

      setCesClient(makeMockCesClient(true));

      const afterAttach = await getSecureKeyResultAsync("openai");
      expect(afterAttach.unreachable).toBe(false);
      expect(getActiveBackendName()).toBe("ces-rpc");
    });
  });

  // -----------------------------------------------------------------------
  // Session ownership: boot claims reconnect before identity reads
  // -----------------------------------------------------------------------
  describe("CES session owner skips a second open", () => {
    test("a registered reconnect owner does not handshake a live CES socket", async () => {
      const dir = mkdtempSync(join(tmpdir(), "ces-owner-"));
      const socketPath = resolveIpcEndpoint("ces", { workspaceDir: dir }).path;
      const savedDir = process.env.CES_BOOTSTRAP_SOCKET_DIR;
      process.env.CES_BOOTSTRAP_SOCKET_DIR = dir;

      const connections: Array<import("node:net").Socket> = [];
      const server: Server = createServer((socket) => {
        connections.push(socket);
        socket.on("error", () => {});
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));

      try {
        setCesReconnect(async () => undefined);
        const start = Date.now();
        await getSecureKeyAsync("openai");
        expect(Date.now() - start).toBeLessThan(1_000);
        expect(getActiveBackendName()).toBe("unavailable");
        expect(connections.length).toBe(0);
      } finally {
        for (const sock of connections) {
          sock.destroy();
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (savedDir !== undefined) {
          process.env.CES_BOOTSTRAP_SOCKET_DIR = savedDir;
        } else {
          delete process.env.CES_BOOTSTRAP_SOCKET_DIR;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
