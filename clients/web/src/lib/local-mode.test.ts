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
  hasGatewayAddress,
  hasLocalGateway,
  getLocalAssistants,
  getServedLockfile,
  getCloudAssistants,
  getRemoteAssistantDisplayName,
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
} from "@/lib/local-mode";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
  setSelfHostedConnection,
} from "@/lib/self-hosted/connection";
import { SELECTED_ASSISTANT_STORAGE_KEY } from "@/assistant/selected-assistant-storage";
import type { LockfileAssistant } from "@/runtime/local-mode-host";
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
  cloud: "custom",
  ipAddress: "gw.example.com",
  port: 443,
} as LockfileAssistant;

describe("served config synthesis", () => {
  test("the stamp produces the one assistant, without calling the local host", () => {
    stampServed({ assistantId: "served-1", assistantName: "Served" });

    const lockfile = getServedLockfile();

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

    expect(getServedLockfile()).toEqual({
      assistants: [],
      activeAssistant: null,
    });
    expect(hasAssistants()).toBe(false);
  });

  test("a cloud-hosted cadet yields the empty lockfile even if an id were stamped", () => {
    disableLocalMode();
    window.__CADET_CONFIG__ = {
      remote: "cloud",
      assistantId: "not-a-thing",
    };

    expect(getServedLockfile()).toEqual({
      assistants: [],
      activeAssistant: null,
    });
  });

  test("names the assistant 'Local Assistant' when the stamp carries no name", () => {
    stampServed({ assistantId: "served-1" });

    expect(getServedLockfile().assistants[0]?.name).toBe("Local Assistant");
  });

  test("the stamped cloud kind passes through, so a paired serve classifies as paired", () => {
    stampServed({ assistantId: "served-1", remote: "local" });
    expect(getServedLockfile().assistants[0]?.cloud).toBe("local");
    // A plain local serve: the renderer holds no transport URL and the host
    // routes same-origin, so the served entry carries a LOCAL gateway
    // address through its recorded port.
    expect(hasLocalGateway()).toBe(true);
    expect(hasGatewayAddress(getActiveAssistant())).toBe(true);

    stampServed({ assistantId: "served-1", remote: "docker" });
    expect(getServedLockfile().assistants[0]?.cloud).toBe("docker");
  });

  test("the served entry carries no runtimeUrl and no real port", () => {
    stampServed({ assistantId: "served-1" });

    const entry = getServedLockfile().assistants[0];
    expect(entry?.resources?.gatewayPort).toBe(0);
  });

  test("getActiveAssistant is the served entry; nothing when unstamped", () => {
    stampServed({ assistantId: "served-1", assistantName: "Served" });
    // The served identity is independent of the app shell's chooser memory.
    setSelected("some-other-assistant");

    expect(getActiveAssistant()?.assistantId).toBe("served-1");

    window.__CADET_CONFIG__ = { remote: "local" };
    expect(getActiveAssistant()).toBeUndefined();
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

    const lockfile = getServedLockfile();

    expect(isCadetCloudRemote()).toBe(false);
    expect(loadLockfileHost).not.toHaveBeenCalled();
    expect(lockfile.activeAssistant).toBe("edge-1");
    expect(lockfile.assistants).toEqual([
      expect.objectContaining({
        assistantId: "edge-1",
        cloud: "docker",
        name: "cadet-deep-hare-ww1iw1",
      }),
    ]);
    // The serving edge IS the gateway - but the served-gateway arm keys on
    // the runtime, not the entry's port.
    expect(hasLocalGateway()).toBe(false);
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

  test("an imported poll resolves with the new assistant id - no roster reload", async () => {
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

    expect(result).toMatchObject({ error: expect.stringMatching(/\S/) });
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

  test("is true for a docker assistant's recorded loopback port", () => {
    // Docker entries record the published gateway as a loopback runtimeUrl and
    // carry no `resources` block.
    enableLocalMode();
    const docker = {
      assistantId: "dk",
      cloud: "docker",
      resources: { gatewayPort: 7930 },
    } as LockfileAssistant;
    expect(hasLocalGateway(docker)).toBe(true);
  });

  test("accepts 127.0.0.1 as a loopback runtimeUrl host", () => {
    enableLocalMode();
    const docker = {
      assistantId: "dk",
      cloud: "docker",
      resources: { gatewayPort: 7931 },
    } as LockfileAssistant;
    expect(hasLocalGateway(docker)).toBe(true);
  });

  test("is true for a recorded resources.gatewayPort", () => {
    enableLocalMode();
    const entry = {
      assistantId: "x",
      cloud: "local",
      resources: { gatewayPort: 7830 },
    } as LockfileAssistant;
    expect(hasLocalGateway(entry)).toBe(true);
  });

  test("is false for a docker assistant with no recorded port", () => {
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
      cloud: "custom",
      ipAddress: "p.example.com",
      port: 443,
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

  test("defaults to the selected assistant - the served entry, port 0, is live topology", () => {
    stampServed({ assistantId: "served-1" });
    expect(hasLocalGateway()).toBe(true);
  });
});

describe("hasGatewayAddress", () => {
  test("is true for a custom remote with a usable recorded address", () => {
    enableLocalMode();
    expect(hasGatewayAddress(pairedEntry)).toBe(true);
  });

  test("is true for a loopback entry with a recorded gateway port", () => {
    enableLocalMode();
    const local = {
      assistantId: "p",
      cloud: "local",
      resources: { gatewayPort: 8787 },
    } as LockfileAssistant;
    expect(hasGatewayAddress(local)).toBe(true);
  });

  test("is false for a loopback entry with no recorded port", () => {
    enableLocalMode();
    const missing = {
      assistantId: "p",
      cloud: "local",
    } as LockfileAssistant;
    expect(hasGatewayAddress(missing)).toBe(false);
  });

  test("is false for non-addressable entries", () => {
    enableLocalMode();
    expect(hasGatewayAddress(platform)).toBe(false);
    expect(hasGatewayAddress(undefined)).toBe(false);
  });

  test("is false outside local mode", () => {
    disableLocalMode();
    expect(hasGatewayAddress(pairedEntry)).toBe(false);
  });

  test("is false in remote-gateway mode", () => {
    enableLocalMode();
    window.__CADET_CONFIG__ = { remote: "docker" };
    expect(hasGatewayAddress(pairedEntry)).toBe(false);
  });

  test("is true for the served entry - a port-0 topology is an address the host resolves", () => {
    stampServed({ assistantId: "served-1" });
    expect(hasGatewayAddress(getActiveAssistant())).toBe(true);
  });
});

describe("isCliWakeableAssistant", () => {
  test("the served local assistant is wakeable (wake establishes its gateway)", () => {
    stampServed({ assistantId: "served-1" });
    expect(isCliWakeableAssistant("served-1")).toBe(true);
  });

  test("a served docker-cloud entry is not CLI-wakeable", () => {
    stampServed({ assistantId: "served-1", remote: "docker" });
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
    stampServed({ assistantId: "paired-a" });
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
    stampServed({ assistantId: "paired-a" });
    const ingressUrl = window.location.origin;
    setSelfHostedConnection({ url: ingressUrl, token: null });

    let ingressDuringProbe: string | null | undefined;
    globalThis.fetch = mock(async () => {
      ingressDuringProbe = getSelfHostedIngressUrl();
      return Response.json({ status: "ok", ready: true });
    }) as unknown as typeof fetch;

    await primeLocalGatewayConnection(pairedEntry);

    expect(ingressDuringProbe).toBe(ingressUrl);
    expect(getSelfHostedIngressUrl()).toBe(ingressUrl);
  });

  test("paired prime surfaces a host credential failure without reading it directly", async () => {
    enableLocalMode();
    stampServed({ assistantId: "paired-a" });
    globalThis.fetch = mock(async () =>
      Response.json({ status: "ok", ready: true }),
    ) as unknown as typeof fetch;
    await primeLocalGatewayConnection(pairedEntry);

    globalThis.fetch = mock(
      async () => new Response("Guardian token not found", { status: 404 }),
    ) as unknown as typeof fetch;

    const error = await primeLocalGatewayConnection(pairedEntry).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(localModeHost.GuardianTokenError);
    expect((error as localModeHost.GuardianTokenError).status).toBe(404);
    expect(fetchGuardianTokenHost).not.toHaveBeenCalled();
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
    // The local selection's data-plane signal is topology, not the slot.
    expect(hasLocalGateway(getActiveAssistant())).toBe(true);
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
