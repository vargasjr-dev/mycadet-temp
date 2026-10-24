import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { parseLockfile } from "@mycadet/local-mode/contract";

import * as localModeHost from "@/runtime/local-mode-host";

const loadLockfileHost = mock(async (): Promise<localModeHost.Lockfile> => {
  throw new Error("host down");
});

const fetchGuardianTokenHost = mock(async (_id: string) => "guardian-tok");

const unpairAssistantHost = mock(
  async (_assistantId: string): Promise<localModeHost.LockfileWriteResult> => ({
    ok: true as const,
    lockfile: { assistants: [], activeAssistant: null },
  }),
);

const pairingStartHost = mock(
  async (_address: string): Promise<localModeHost.LocalPairingStartResult> => ({
    ok: true as const,
    handle: "handle-1",
    userCode: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
    intervalSeconds: 5,
  }),
);

const pairingPollHost = mock(
  async (
    _handle: string,
    _name?: string,
  ): Promise<localModeHost.LocalPairingPollResult> => ({
    ok: true as const,
    status: "imported" as const,
    assistantId: "paired-new",
    accessOnly: false,
  }),
);

const pairingCancelHost = mock(async (_handle: string): Promise<void> => {});

mock.module("@/runtime/local-mode-host", () => ({
  ...localModeHost,
  loadLockfileHost,
  fetchGuardianTokenHost,
  unpairAssistantHost,
  pairingStartHost,
  pairingPollHost,
  pairingCancelHost,
}));

import {
  getActiveAssistant,
  hasLocalGateway,
  hasPairedGateway,
  getLocalAssistants,
  getLockfile,
  getCloudAssistants,
  getRemoteAssistantDisplayName,
  getSelectedAssistant,
  cancelAssistantPairing,
  pollAssistantPairing,
  startAssistantPairing,
  isCliWakeableAssistant,
  isLocalAssistant,
  isCadetCloudRemote,
  isCloudAssistant,
  isRetryablePairingFailure,
  hasAssistants,
  LOCAL_GATEWAY_STARTUP_RETRY,
  primeLocalGatewayConnection,
  primeLocalGatewayConnectionWithStartupRetry,
  removePairedAssistantFromLockfile,
  UnresolvedLocalGatewayError,
  hasGatewayAssistant,
  isGatewaySessionLive,
} from "@/lib/local-mode";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
  setSelfHostedConnection,
} from "@/lib/self-hosted/connection";
import { SELECTED_ASSISTANT_STORAGE_KEY } from "@/assistant/selected-assistant-storage";
import type { Lockfile, LockfileAssistant } from "@/runtime/local-mode-host";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const realFetch = globalThis.fetch;

function setSelected(id: string): void {
  localStorage.setItem(SELECTED_ASSISTANT_STORAGE_KEY, id);
}

// Tests default to cloud-served mode (test-setup.ts stamps the config), but
// this file's local paths need the local arm: every test starts stamped
// local, the cloud/served-gateway descriptions override per test, and the
// afterEach restores the suite default.
function enableLocalMode(): void {
  window.__CADET_CONFIG__ = { remote: "local" };
}

function disableLocalMode(): void {
  window.__CADET_CONFIG__ = { remote: "cloud" };
}

/**
 * Stamp the served assistant the way every host now does: the desktop
 * preload (selection ?? active ?? sole from the watched lockfile), the dev
 * server (the lockfile's active), the nginx edge (its ingress choice).
 */
function stampServed(
  config: Record<string, unknown> & { assistantId?: string },
): void {
  window.__CADET_CONFIG__ = { remote: "local", ...config };
}

beforeEach(() => {
  window.__CADET_CONFIG__ = { remote: "local" };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  window.__CADET_CONFIG__ = { remote: "cloud" };
  localStorage.removeItem(SELECTED_ASSISTANT_STORAGE_KEY);
  loadLockfileHost.mockClear();
  fetchGuardianTokenHost.mockClear();
  unpairAssistantHost.mockClear();
  pairingStartHost.mockClear();
  pairingPollHost.mockClear();
  pairingCancelHost.mockClear();
  setSelfHostedConnection(null);
  useAssistantIdentityStore.getState().clearIdentity();
});

const localA: LockfileAssistant = {
  assistantId: "local-a",
  cloud: "local",
  resources: { gatewayPort: 7830, daemonPort: 7831 },
} as LockfileAssistant;

const platform: LockfileAssistant = {
  assistantId: "platform-a",
  cloud: "cloud",
} as LockfileAssistant;

const pairedEntry: LockfileAssistant = {
  assistantId: "paired-a",
  cloud: "local",
  runtimeUrl: "https://gw.example.com",
} as LockfileAssistant;

describe("served config synthesis", () => {
  test("the stamp produces the one assistant, without calling the local host", () => {
    stampServed({ assistantId: "served-1", assistantName: "Served" });

    const lockfile = getLockfile();

    expect(loadLockfileHost).not.toHaveBeenCalled();
    expect(lockfile.activeAssistant).toBe("served-1");
    expect(lockfile.assistants).toEqual([
      expect.objectContaining({
        assistantId: "served-1",
        cloud: "local",
        name: "Served",
      }),
    ]);
    expect(getLocalAssistants().map((a) => a.assistantId)).toEqual([
      "served-1",
    ]);
    expect(hasAssistants()).toBe(true);
  });

  test("a host that stamps no assistant yields the empty lockfile (pre-hatch)", () => {
    window.__CADET_CONFIG__ = { remote: "local" };

    expect(getLockfile()).toEqual({ assistants: [], activeAssistant: null });
    expect(hasAssistants()).toBe(false);
  });

  test("a cloud-hosted cadet yields the empty lockfile even if an id were stamped", () => {
    disableLocalMode();
    window.__CADET_CONFIG__ = {
      remote: "cloud",
      assistantId: "not-a-thing",
    };

    expect(getLockfile()).toEqual({ assistants: [], activeAssistant: null });
  });

  test("names the assistant 'Local Assistant' when the stamp carries no name", () => {
    stampServed({ assistantId: "served-1" });

    expect(getLockfile().assistants[0]?.name).toBe("Local Assistant");
  });

  test("the stamped cloud kind passes through, so a paired serve classifies as paired", () => {
    stampServed({ assistantId: "served-1", assistantCloud: "local" });
    expect(getLockfile().assistants[0]?.cloud).toBe("local");
    // A plain local serve: the renderer holds no transport URL and the host
    // routes same-origin, so the served entry must classify as a LOCAL
    // gateway (never as a paired one — the wake repair refuses paired).
    expect(hasLocalGateway()).toBe(true);
    expect(hasPairedGateway(getSelectedAssistant())).toBe(false);

    stampServed({ assistantId: "served-1", assistantCloud: "docker" });
    expect(getLockfile().assistants[0]?.cloud).toBe("docker");
  });

  test("the served entry carries no runtimeUrl and no real port", () => {
    stampServed({ assistantId: "served-1" });

    const entry = getLockfile().assistants[0];
    expect(entry?.runtimeUrl).toBeUndefined();
    expect(entry?.resources?.gatewayPort).toBe(0);
  });

  test("getSelectedAssistant is the served entry; nothing when unstamped", () => {
    stampServed({ assistantId: "served-1", assistantName: "Served" });
    // The raw selection key is the app shell's memory — web no longer
    // resolves against it; the host resolved the selection at stamp time.
    setSelected("some-other-assistant");

    expect(getSelectedAssistant()?.assistantId).toBe("served-1");

    window.__CADET_CONFIG__ = { remote: "local" };
    expect(getSelectedAssistant()).toBeUndefined();
    expect(getActiveAssistant()).toBeUndefined();
  });
});

describe("remote gateway mode", () => {
  test("isCadetCloudRemote splits cloud from the gateway-auth remotes", () => {
    // Shells serving the local cadet (desktop, dev server) inject no remote;
    // the reader defaults it to "local".
    window.__CADET_CONFIG__ = {};
    expect(isCadetCloudRemote()).toBe(false);

    // A declared "local" remote behaves the same as an absent one.
    window.__CADET_CONFIG__ = { remote: "local" };
    expect(isCadetCloudRemote()).toBe(false);

    // A self-hosted edge and a docker cadet share the gateway-token scheme.
    window.__CADET_CONFIG__ = { remote: "custom" };
    expect(isCadetCloudRemote()).toBe(false);
    window.__CADET_CONFIG__ = { remote: "docker" };
    expect(isCadetCloudRemote()).toBe(false);

    // The cloud remote is the only one behind the cloud cookie scheme.
    window.__CADET_CONFIG__ = { remote: "cloud" };
    expect(isCadetCloudRemote()).toBe(true);
  });

  test("a served runtime synthesizes its stamped assistant without a host call", () => {
    window.__CADET_CONFIG__ = {
      remote: "docker",
      assistantId: "edge-1",
      assistantName: "cadet-deep-hare-ww1iw1",
    };

    const lockfile = getLockfile();

    expect(isCadetCloudRemote()).toBe(false);
    expect(loadLockfileHost).not.toHaveBeenCalled();
    expect(lockfile.activeAssistant).toBe("edge-1");
    expect(lockfile.assistants).toEqual([
      expect.objectContaining({
        assistantId: "edge-1",
        cloud: "local",
        name: "cadet-deep-hare-ww1iw1",
      }),
    ]);
    // The serving edge IS the gateway — but the served-gateway arm's
    // session vision keys on the runtime, not the entry's port.
    expect(hasLocalGateway()).toBe(false);
    expect(hasGatewayAssistant()).toBe(true);
  });
});

describe("getRemoteAssistantDisplayName", () => {
  test("prefers the live identity-store name over the injected config", () => {
    window.__CADET_CONFIG__ = {
      remote: "docker",
      assistantName: "cadet-deep-hare-ww1iw1",
    };
    useAssistantIdentityStore.getState().setIdentity("Credence", "1.0.0");

    expect(getRemoteAssistantDisplayName()).toBe("Credence");
  });

  test("falls back to the injected config for a whitespace-only live name", () => {
    window.__CADET_CONFIG__ = {
      remote: "docker",
      assistantName: "cadet-deep-hare-ww1iw1",
    };
    useAssistantIdentityStore.getState().setIdentity("   ", "1.0.0");

    expect(getRemoteAssistantDisplayName()).toBe("cadet-deep-hare-ww1iw1");
  });

  test("is undefined when neither source carries a name", () => {
    window.__CADET_CONFIG__ = { remote: "docker" };

    expect(getRemoteAssistantDisplayName()).toBeUndefined();
  });
});

describe("removePairedAssistantFromLockfile", () => {
  // Referenced by variable so the AST-based raw-fetch rule (which only
  // matches literal key arguments) does not fire in test-only setItem calls.
  const GW_LS_TOKEN_KEY = "cadet:gw:token";

  function seedSessionResidue(): void {
    localStorage.setItem(GW_LS_TOKEN_KEY, "tok");
    setSelfHostedConnection({ url: "http://localhost/x", token: null });
  }

  test("validates the id against the host's roster, then calls the host unpair", async () => {
    loadLockfileHost.mockResolvedValueOnce({
      assistants: [localA, pairedEntry],
      activeAssistant: "local-a",
    });

    const result = await removePairedAssistantFromLockfile("paired-a");

    expect(loadLockfileHost).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
    expect(unpairAssistantHost).toHaveBeenCalledWith("paired-a");
  });

  test("refuses an id the host roster doesn't know without calling the unpair", async () => {
    loadLockfileHost.mockResolvedValueOnce({
      assistants: [pairedEntry],
      activeAssistant: null,
    });

    const result = await removePairedAssistantFromLockfile("nope");

    expect(result.ok).toBe(false);
    expect(unpairAssistantHost).not.toHaveBeenCalled();
  });

  test("an unreachable host does not block the removal attempt", async () => {
    // The host validates the id itself; a failed pre-read must not strand
    // the removal behind a dead transport.
    const result = await removePairedAssistantFromLockfile("paired-a");

    expect(unpairAssistantHost).toHaveBeenCalledWith("paired-a");
    expect(result).toEqual({ ok: true });
  });

  test("propagates a host failure without clearing session state", async () => {
    loadLockfileHost.mockResolvedValueOnce({
      assistants: [pairedEntry],
      activeAssistant: null,
    });
    setSelected("paired-a");
    unpairAssistantHost.mockResolvedValueOnce({
      ok: false,
      error: "Unpair is not supported by this app version",
    });

    const result = await removePairedAssistantFromLockfile("paired-a");

    expect(result).toEqual({
      ok: false,
      error: "Unpair is not supported by this app version",
    });
    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBe(
      "paired-a",
    );
  });

  test("clears selection and self-hosted connection when removing the selected entry", async () => {
    loadLockfileHost.mockResolvedValueOnce({
      assistants: [localA, pairedEntry],
      activeAssistant: "local-a",
    });
    setSelected("paired-a");
    seedSessionResidue();
    unpairAssistantHost.mockResolvedValueOnce({
      ok: true as const,
      lockfile: { assistants: [localA], activeAssistant: "local-a" },
    });

    const result = await removePairedAssistantFromLockfile("paired-a");

    expect(result.ok).toBe(true);
    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBeNull();
    // The slot is memory-only now — stored keys are never scrubbed.
    expect(localStorage.getItem(GW_LS_TOKEN_KEY)).toBe("tok");
    expect(getSelfHostedIngressUrl()).toBeNull();
  });

  test("leaves session state alone when removing a non-selected entry", async () => {
    loadLockfileHost.mockResolvedValueOnce({
      assistants: [localA, pairedEntry],
      activeAssistant: "local-a",
    });
    setSelected("local-a");
    seedSessionResidue();
    unpairAssistantHost.mockResolvedValueOnce({
      ok: true as const,
      lockfile: { assistants: [localA], activeAssistant: "local-a" },
    });

    const result = await removePairedAssistantFromLockfile("paired-a");

    expect(result.ok).toBe(true);
    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBe(
      "local-a",
    );
    expect(localStorage.getItem(GW_LS_TOKEN_KEY)).toBe("tok");
    expect(getSelfHostedIngressUrl()).toBe("http://localhost/x");
  });
});

describe("assistant pairing", () => {
  test("starts the attempt through the host without touching any lockfile", async () => {
    const result = await startAssistantPairing("https://gw.example.com");

    expect(pairingStartHost).toHaveBeenCalledWith("https://gw.example.com");
    expect(result).toMatchObject({ ok: true, handle: "handle-1" });
    expect(loadLockfileHost).not.toHaveBeenCalled();
  });

  test("an imported poll resolves with the new assistant id — no roster reload", async () => {
    const result = await pollAssistantPairing("handle-1", "desk");

    expect(pairingPollHost).toHaveBeenCalledWith("handle-1", "desk");
    expect(result).toEqual({
      ok: true,
      status: "imported",
      assistantId: "paired-new",
      accessOnly: false,
    });
    expect(loadLockfileHost).not.toHaveBeenCalled();
  });

  test("a pending poll passes the cadence through", async () => {
    pairingPollHost.mockResolvedValueOnce({
      ok: true as const,
      status: "pending" as const,
      expiresAt: "2099-01-01T00:00:00.000Z",
      intervalSeconds: 3,
    });

    const result = await pollAssistantPairing("handle-1");

    expect(result).toMatchObject({ status: "pending", intervalSeconds: 3 });
    expect(loadLockfileHost).not.toHaveBeenCalled();
  });

  test("passes accessOnly through on an access-only pairing", async () => {
    pairingPollHost.mockResolvedValueOnce({
      ok: true as const,
      status: "imported" as const,
      assistantId: "paired-new",
      accessOnly: true,
    });

    const result = await pollAssistantPairing("handle-1");

    expect(result).toMatchObject({ accessOnly: true });
  });

  test("returns the host error without a reload on failure", async () => {
    pairingPollHost.mockResolvedValueOnce({
      ok: false,
      reason: "expired",
      error: "The pairing code expired or was denied.",
    });

    const result = await pollAssistantPairing("handle-1");

    expect(result).toEqual({
      ok: false,
      reason: "expired",
      error: "The pairing code expired or was denied.",
    });
    expect(loadLockfileHost).not.toHaveBeenCalled();
  });

  // The dialog renders its own catalog copy for a refused address, so the
  // structured reason has to survive the wrapper.
  test("a refused address keeps its rejection reason", async () => {
    pairingStartHost.mockResolvedValueOnce({
      ok: false,
      reason: "invalid-address",
      error: "That address points back at this machine.",
      rejection: "loopback",
    });

    const result = await startAssistantPairing("https://localhost:7830");

    expect(result).toEqual({
      ok: false,
      reason: "invalid-address",
      error: "That address points back at this machine.",
      rejection: "loopback",
    });
  });

  test("a rejection reason with no copy degrades to the host's message", async () => {
    pairingStartHost.mockResolvedValueOnce({
      ok: false,
      reason: "unheard-of-reason",
      error: "host says no",
    } as never);

    const result = await startAssistantPairing("https://localhost:7830");

    expect(result).toMatchObject({ error: "host says no" });
  });

  test("an error-less host failure still reports something displayable", async () => {
    pairingStartHost.mockResolvedValueOnce({ ok: false } as never);

    const result = await startAssistantPairing("https://localhost:7830");

    expect(result).toMatchObject({ error: expect.any(String) });
    expect((result as { error?: string }).error?.length ?? 0).toBeGreaterThan(
      0,
    );
  });

  test("cancelling forwards the handle to the host", async () => {
    await cancelAssistantPairing("handle-1");
    expect(pairingCancelHost).toHaveBeenCalledWith("handle-1");
  });

  test("cancelling a session the host rejects resolves quietly", async () => {
    pairingCancelHost.mockImplementationOnce(async () => {
      throw new Error("unknown handle");
    });
    await expect(cancelAssistantPairing("handle-1")).resolves.toBeUndefined();
  });

  test.each([
    { reason: "invalid-address", retryable: false },
    { reason: "code-expired", retryable: false },
    { reason: "unreachable", retryable: true },
  ])(
    "a $reason failure classifies as retryable=$retryable",
    ({ reason, retryable }) => {
      expect(
        isRetryablePairingFailure({
          reason,
        } as localModeHost.LocalPairingFailure),
      ).toBe(retryable);
    },
  );

  test("a host too old to name a reason ends the attempt", () => {
    expect(
      isRetryablePairingFailure({} as localModeHost.LocalPairingFailure),
    ).toBe(false);
  });
});

describe("assistant classification", () => {
  test("a cadet-cloud entry is a cloud assistant, not local", () => {
    expect(isCloudAssistant(platform)).toBe(true);
    expect(isLocalAssistant(platform)).toBe(false);
  });

  test("a local-cloud entry with a gateway port is local, not platform", () => {
    expect(isLocalAssistant(localA)).toBe(true);
    expect(isCloudAssistant(localA)).toBe(false);
  });

  test("a local-cloud entry without a gateway port is still local (identity, not connectivity)", () => {
    const portless = { assistantId: "x", cloud: "local" } as LockfileAssistant;
    expect(isLocalAssistant(portless)).toBe(true);
    expect(isCloudAssistant(portless)).toBe(false);
  });

  test("externally-managed container runtimes are not web-client local", () => {
    // Docker and apple-container are managed by the CLI / macOS app, not the
    // web client's lifecycle flows — so restart/retire/logout routing must keep
    // treating them as non-local.
    const docker = { assistantId: "d", cloud: "docker" } as LockfileAssistant;
    const appleContainer = {
      assistantId: "a",
      cloud: "apple-container",
    } as LockfileAssistant;
    expect(isLocalAssistant(docker)).toBe(false);
    expect(isLocalAssistant(appleContainer)).toBe(false);
  });

  test("a legacy entry with no cloud normalizes to local at the parse seam", () => {
    // Entries that predate the `cloud` field are normalized to "local" by
    // parseLockfile (see @mycadet/local-mode/contract), so by the time one
    // reaches isLocalAssistant its cloud is already set.
    const { assistants } = parseLockfile({
      assistants: [{ assistantId: "old" }],
      activeAssistant: null,
    });
    expect(isLocalAssistant(assistants[0]!)).toBe(true);
  });

  test("remote self-hosted clouds are neither local nor platform", () => {
    const remote = {
      assistantId: "r-custom",
      cloud: "custom",
    } as LockfileAssistant;
    expect(isLocalAssistant(remote)).toBe(false);
    expect(isCloudAssistant(remote)).toBe(false);
  });

  test("the synthesis partitions to the served local entry; cloud rows never appear", () => {
    stampServed({ assistantId: "served-1" });
    expect(getLocalAssistants().map((a) => a.assistantId)).toEqual([
      "served-1",
    ]);
    expect(getCloudAssistants()).toEqual([]);
  });
});

describe("hasLocalGateway", () => {
  test("is true for a local assistant with a recorded port", () => {
    enableLocalMode();
    expect(hasLocalGateway(localA)).toBe(true);
  });

  test("is false for a local assistant with no recorded gateway port", () => {
    enableLocalMode();
    const portless = { assistantId: "x", cloud: "local" } as LockfileAssistant;
    expect(hasLocalGateway(portless)).toBe(false);
  });

  test("is true for a docker assistant's loopback runtimeUrl", () => {
    // Docker entries record the published gateway as a loopback runtimeUrl and
    // carry no `resources` block.
    enableLocalMode();
    const docker = {
      assistantId: "dk",
      cloud: "docker",
      runtimeUrl: "http://localhost:7930",
    } as LockfileAssistant;
    expect(hasLocalGateway(docker)).toBe(true);
  });

  test("accepts 127.0.0.1 as a loopback runtimeUrl host", () => {
    enableLocalMode();
    const docker = {
      assistantId: "dk",
      cloud: "docker",
      runtimeUrl: "http://127.0.0.1:7931",
    } as LockfileAssistant;
    expect(hasLocalGateway(docker)).toBe(true);
  });

  test("prefers a recorded resources.gatewayPort over the runtimeUrl port", () => {
    enableLocalMode();
    const entry = {
      assistantId: "x",
      cloud: "local",
      runtimeUrl: "http://localhost:9999",
      resources: { gatewayPort: 7830 },
    } as LockfileAssistant;
    expect(hasLocalGateway(entry)).toBe(true);
  });

  test("is false for a non-loopback runtimeUrl", () => {
    enableLocalMode();
    const docker = {
      assistantId: "dk",
      cloud: "docker",
      runtimeUrl: "http://assistant.example.com:7930",
    } as LockfileAssistant;
    expect(hasLocalGateway(docker)).toBe(false);
  });

  test("is false for a docker assistant with no runtimeUrl or port", () => {
    enableLocalMode();
    const bare = { assistantId: "dk", cloud: "docker" } as LockfileAssistant;
    expect(hasLocalGateway(bare)).toBe(false);
  });

  test("is false for a cloud assistant", () => {
    enableLocalMode();
    expect(hasLocalGateway(platform)).toBe(false);
  });

  test("is false for a remote (paired) assistant", () => {
    enableLocalMode();
    const paired = {
      assistantId: "p",
      cloud: "local",
      runtimeUrl: "https://p.example.com",
    } as LockfileAssistant;
    expect(hasLocalGateway(paired)).toBe(false);
  });

  test("is false outside local mode even for a local assistant with a port", () => {
    disableLocalMode();
    expect(hasLocalGateway(localA)).toBe(false);
  });

  test("is false in a served-gateway runtime (the runtime's own vision covers it)", () => {
    window.__CADET_CONFIG__ = {
      remote: "docker",
      assistantId: "edge-1",
    };
    expect(hasLocalGateway()).toBe(false);
  });

  test("defaults to the selected assistant — the served entry, port 0, is live topology", () => {
    stampServed({ assistantId: "served-1" });
    expect(hasLocalGateway()).toBe(true);
  });
});

describe("hasPairedGateway", () => {
  test("is true for a usable paired entry", () => {
    enableLocalMode();
    expect(hasPairedGateway(pairedEntry)).toBe(true);
  });

  test("accepts runtimeUrls with trailing slashes or path prefixes", () => {
    enableLocalMode();
    for (const runtimeUrl of [
      "https://gw.example.com///",
      "https://gw.example.com/assistant/",
    ]) {
      const paired = { ...pairedEntry, runtimeUrl } as LockfileAssistant;
      expect(hasPairedGateway(paired)).toBe(true);
    }
  });

  test("is false for a non-http(s) runtimeUrl", () => {
    enableLocalMode();
    const paired = {
      ...pairedEntry,
      runtimeUrl: "ftp://x",
    } as LockfileAssistant;
    expect(hasPairedGateway(paired)).toBe(false);
  });

  test("is false for a missing or malformed runtimeUrl", () => {
    enableLocalMode();
    const missing = {
      assistantId: "p",
      cloud: "local",
    } as LockfileAssistant;
    const malformed = {
      ...pairedEntry,
      runtimeUrl: "not a url",
    } as LockfileAssistant;
    expect(hasPairedGateway(missing)).toBe(false);
    expect(hasPairedGateway(malformed)).toBe(false);
  });

  test("is false for non-paired entries", () => {
    enableLocalMode();
    expect(hasPairedGateway(localA)).toBe(false);
    expect(hasPairedGateway(platform)).toBe(false);
    expect(hasPairedGateway(undefined)).toBe(false);
  });

  test("is false outside local mode", () => {
    disableLocalMode();
    expect(hasPairedGateway(pairedEntry)).toBe(false);
  });

  test("is false in remote-gateway mode", () => {
    enableLocalMode();
    window.__CADET_CONFIG__ = { remote: "docker" };
    expect(hasPairedGateway(pairedEntry)).toBe(false);
  });

  test("is false for the served entry — a local serve is never a paired one", () => {
    stampServed({ assistantId: "served-1" });
    expect(hasPairedGateway(getSelectedAssistant())).toBe(false);
  });
});

describe("isCliWakeableAssistant", () => {
  test("the served local assistant is wakeable (wake establishes its gateway)", () => {
    stampServed({ assistantId: "served-1" });
    expect(isCliWakeableAssistant("served-1")).toBe(true);
  });

  test("a served docker-cloud entry is not CLI-wakeable", () => {
    stampServed({ assistantId: "served-1", assistantCloud: "docker" });
    expect(isCliWakeableAssistant("served-1")).toBe(false);
  });

  test("an unknown id is not wakeable", () => {
    stampServed({ assistantId: "served-1" });
    expect(isCliWakeableAssistant("nope")).toBe(false);
  });
});

describe("primeLocalGatewayConnection", () => {
  test("throws UnresolvedLocalGatewayError for a local assistant with no resolved gateway", async () => {
    enableLocalMode();
    const portless = {
      assistantId: "legacy",
      cloud: "local",
    } as LockfileAssistant;
    await expect(primeLocalGatewayConnection(portless)).rejects.toBeInstanceOf(
      UnresolvedLocalGatewayError,
    );
  });

  test("throws UnresolvedLocalGatewayError for a docker assistant with no resolvable gateway", async () => {
    enableLocalMode();
    const bare = { assistantId: "dk", cloud: "docker" } as LockfileAssistant;
    await expect(primeLocalGatewayConnection(bare)).rejects.toBeInstanceOf(
      UnresolvedLocalGatewayError,
    );
  });

  test("is a no-op for a cloud assistant even in local mode", async () => {
    enableLocalMode();
    await expect(
      primeLocalGatewayConnection(platform),
    ).resolves.toBeUndefined();
  });

  test("is a no-op for a paired assistant outside local mode", async () => {
    disableLocalMode();
    await expect(
      primeLocalGatewayConnection(pairedEntry),
    ).resolves.toBeUndefined();
    expect(fetchGuardianTokenHost).not.toHaveBeenCalled();
  });

  test("paired prime reaches the host proxy without exposing a bearer", async () => {
    enableLocalMode();
    stampServed({
      assistantId: "paired-a",
      assistantRuntimeUrl: "https://gw.example.com",
    });
    // Referenced by variable so the AST-based raw-fetch rule (which only
    // matches literal key arguments) does not fire in test-only setItem
    // calls.
    const GW_LS_TOKEN_KEY = "cadet:gw:token";
    localStorage.setItem(GW_LS_TOKEN_KEY, "legacy-paired-guardian");
    const fetchSpy = mock(async () =>
      Response.json({ status: "ok", ready: true }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await primeLocalGatewayConnection(pairedEntry);

    expect(fetchSpy).toHaveBeenCalledWith("/v1/assistants/paired-a/readyz");
    expect(fetchGuardianTokenHost).not.toHaveBeenCalled();
    // The connection rides the same-origin scoped data plane (`/v1`, routed
    // by the host through the id in the path) — never the remote runtimeUrl
    // directly (packaged-app CSP and browser CORS both block it).
    expect(getSelfHostedIngressUrl()).toBe(window.location.origin);
    expect(getSelfHostedActorToken()).toBeNull();
    expect(isGatewaySessionLive()).toBe(true);
    // The prime neither reads nor scrubs stored credentials — LS rides out untouched.
    expect(localStorage.getItem(GW_LS_TOKEN_KEY)).toBe(
      "legacy-paired-guardian",
    );
    expect(localStorage.getItem("cadet:gw:tokenSource")).toBeNull();
  });

  test("paired re-prime keeps the connection live while the readiness probe is in flight", async () => {
    // A re-prime while a same-origin slot is primed must not open a window
    // in which the slot is empty: requests issued then would fall through to
    // the cloud and gateway-auth predicates would read false.
    enableLocalMode();
    stampServed({
      assistantId: "paired-a",
      assistantRuntimeUrl: "https://gw.example.com",
    });
    const ingressUrl = window.location.origin;
    setSelfHostedConnection({ url: ingressUrl, token: null });

    let ingressDuringProbe: string | null | undefined;
    let authModeDuringProbe: boolean | undefined;
    globalThis.fetch = mock(async () => {
      ingressDuringProbe = getSelfHostedIngressUrl();
      authModeDuringProbe = isGatewaySessionLive();
      return Response.json({ status: "ok", ready: true });
    }) as unknown as typeof fetch;

    await primeLocalGatewayConnection(pairedEntry);

    expect(ingressDuringProbe).toBe(ingressUrl);
    expect(authModeDuringProbe).toBe(true);
    expect(getSelfHostedIngressUrl()).toBe(ingressUrl);
  });

  test("paired prime surfaces a host credential failure without reading it directly", async () => {
    enableLocalMode();
    stampServed({
      assistantId: "paired-a",
      assistantRuntimeUrl: "https://gw.example.com",
    });
    globalThis.fetch = mock(async () =>
      Response.json({ status: "ok", ready: true }),
    ) as unknown as typeof fetch;
    await primeLocalGatewayConnection(pairedEntry);
    expect(isGatewaySessionLive()).toBe(true);

    globalThis.fetch = mock(
      async () => new Response("Guardian token not found", { status: 404 }),
    ) as unknown as typeof fetch;

    const error = await primeLocalGatewayConnection(pairedEntry).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(localModeHost.GuardianTokenError);
    expect((error as localModeHost.GuardianTokenError).status).toBe(404);
    expect(fetchGuardianTokenHost).not.toHaveBeenCalled();
    expect(isGatewaySessionLive()).toBe(false);
  });

  test("unready paired prime clears the shared same-origin slot", async () => {
    enableLocalMode();
    // The selected (served) assistant is a local gateway, so after the
    // failed paired prime the local selection's session stays topology-live.
    stampServed({ assistantId: "served-1" });
    setSelfHostedConnection({
      url: window.location.origin,
      token: null,
    });
    globalThis.fetch = mock(async () =>
      Response.json({ status: "migrating", ready: false }),
    ) as unknown as typeof fetch;

    await expect(primeLocalGatewayConnection(pairedEntry)).rejects.toThrow(
      "Assistant is not ready",
    );

    // The slot is assistant-anonymous (every prime seeds the bare origin), so
    // a failed probe clears it — a connect flow re-primes on retry.
    expect(getSelfHostedIngressUrl()).toBeNull();
    expect(getSelfHostedActorToken()).toBeNull();
    // The local selection's session signal is topology, not the slot.
    expect(isGatewaySessionLive()).toBe(true);
  });
});

describe("primeLocalGatewayConnectionWithStartupRetry (paired target)", () => {
  // The startup ride-out exists for the LOCAL gateway's Login Item window.
  // Paired failures (failed host credential read, remote transport error) fall
  // through promptly to the chooser instead of stalling the boot retry budget
  // on a machine that waiting cannot start.
  test("a failing paired credential read is not ridden out", async () => {
    enableLocalMode();
    const fetchMock = mock(
      async () => new Response("Guardian token not found", { status: 404 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const start = Date.now();
    await expect(
      primeLocalGatewayConnectionWithStartupRetry(pairedEntry),
    ).rejects.toBeInstanceOf(localModeHost.GuardianTokenError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchGuardianTokenHost).not.toHaveBeenCalled();
    expect(Date.now() - start).toBeLessThan(
      LOCAL_GATEWAY_STARTUP_RETRY.intervalMs,
    );
  });

  test("a remote transport failure is not ridden out either", async () => {
    enableLocalMode();
    const fetchMock = mock(async () => {
      throw new TypeError("Failed to fetch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      primeLocalGatewayConnectionWithStartupRetry(pairedEntry),
    ).rejects.toThrow("Failed to fetch");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchGuardianTokenHost).not.toHaveBeenCalled();
  });
});

describe("gateway session vision (hasGatewayAssistant / isGatewaySessionLive)", () => {
  test("a served runtime always has a gateway assistant; the session goes live with the slot token", () => {
    window.__CADET_CONFIG__ = {
      remote: "docker",
      assistantId: "edge-1",
    };

    expect(hasGatewayAssistant()).toBe(true);
    expect(isGatewaySessionLive()).toBe(false);

    // The pairing exchange plants the device credential in the connection
    // slot — the single bearer custody.
    setSelfHostedConnection({ url: window.location.origin, token: "tok" });

    expect(isGatewaySessionLive()).toBe(true);
  });

  test("a paired serve has a gateway assistant only with a usable runtimeUrl", () => {
    enableLocalMode();
    stampServed({
      assistantId: "paired-a",
      assistantRuntimeUrl: "https://gw.example.com",
    });
    expect(hasGatewayAssistant()).toBe(true);

    stampServed({ assistantId: "paired-a", assistantRuntimeUrl: "not a url" });
    expect(hasGatewayAssistant()).toBe(false);
  });

  test("a paired serve outside local mode has no gateway assistant", () => {
    window.__CADET_CONFIG__ = { remote: "cloud" };
    expect(hasGatewayAssistant()).toBe(false);
    expect(isGatewaySessionLive()).toBe(false);
  });

  test("a paired serve goes live only once the prime has seeded the slot", () => {
    enableLocalMode();
    stampServed({
      assistantId: "paired-a",
      assistantRuntimeUrl: "https://gw.example.com",
    });
    const fetchSpy = mock(async () => {
      throw new Error("unexpected fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    expect(isGatewaySessionLive()).toBe(false);

    setSelfHostedConnection({ url: window.location.origin, token: null });

    expect(isGatewaySessionLive()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a served local selection's session is topology — live without any slot", () => {
    stampServed({ assistantId: "served-1" });
    // The host IS the gateway and the synthesis records a resolvable one
    // (port 0): no prime, no slot, no token — the trusted host owns custody.
    expect(hasGatewayAssistant()).toBe(true);
    expect(isGatewaySessionLive()).toBe(true);

    // Nothing stamped (pre-hatch) — no gateway assistant at all.
    window.__CADET_CONFIG__ = { remote: "local" };
    expect(hasGatewayAssistant()).toBe(false);
    expect(isGatewaySessionLive()).toBe(false);
  });
});
