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
  getAuthGatewayIngressUrl,
  getLocalGatewayUrl,
  getLocalAssistants,
  getLockfile,
  getPairedGatewayUrl,
  getCloudAssistants,
  getRemoteAssistantDisplayName,
  getSelectedAssistant,
  cancelAssistantPairing,
  pollAssistantPairing,
  startAssistantPairing,
  isCliWakeableAssistant,
  isLocalAssistant,
  isLocalGatewayAssistant,
  isPairedAssistant,
  isCadetCloudRemote,
  isCloudAssistant,
  isRetryablePairingFailure,
  loadLockfile,
  LOCAL_GATEWAY_STARTUP_RETRY,
  primeLocalGatewayConnection,
  primeLocalGatewayConnectionWithStartupRetry,
  reconcileSelectedAssistant,
  removePairedAssistantFromLockfile,
  UnresolvedLocalGatewayError,
  UnresolvedPairedGatewayError,
} from "@/lib/local-mode";
import {
  clearGatewayToken,
  getGatewayToken,
  isGatewayAuthMode,
  seedGatewayToken,
} from "@/lib/auth/gateway-session";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
  setSelfHostedConnection,
} from "@/lib/self-hosted/connection";
import { SELECTED_ASSISTANT_STORAGE_KEY } from "@/assistant/selected-assistant-storage";
import type { Lockfile, LockfileAssistant } from "@/runtime/local-mode-host";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useLockfileStore } from "@/stores/lockfile-store";

const LOCKFILE_STORAGE_KEY = "cadet:local:lockfile";
const realFetch = globalThis.fetch;

function setSelected(id: string): void {
  localStorage.setItem(SELECTED_ASSISTANT_STORAGE_KEY, id);
}

const localA: LockfileAssistant = {
  assistantId: "local-a",
  cloud: "local",
  resources: { gatewayPort: 7830 },
} as LockfileAssistant;

const localB: LockfileAssistant = {
  assistantId: "local-b",
  cloud: "local",
  resources: { gatewayPort: 7831 },
} as LockfileAssistant;

const platform: LockfileAssistant = {
  assistantId: "platform-a",
  cloud: "cadet",
} as LockfileAssistant;

const pairedEntry: LockfileAssistant = {
  assistantId: "paired-a",
  cloud: "paired",
  runtimeUrl: "https://gw.example.com",
} as LockfileAssistant;

function setLockfile(lockfile: Lockfile): void {
  useLockfileStore.setState({ lockfile });
}

// Tests default to cloud-served mode (test-setup.ts stamps the config), but
// this file's host-read paths need the local arm: every test starts stamped
// local, the cloud/served-gateway describes override per test, and the
// afterEach restores the suite default.
function enableLocalMode(): void {
  window.__CADET_CONFIG__ = { remote: "local" };
}

function disableLocalMode(): void {
  window.__CADET_CONFIG__ = { remote: "cloud" };
}

beforeEach(() => {
  window.__CADET_CONFIG__ = { remote: "local" };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  window.__CADET_CONFIG__ = { remote: "cloud" };
  useLockfileStore.setState({ lockfile: null, committed: false });
  localStorage.removeItem(LOCKFILE_STORAGE_KEY);
  localStorage.removeItem(SELECTED_ASSISTANT_STORAGE_KEY);
  loadLockfileHost.mockClear();
  fetchGuardianTokenHost.mockClear();
  unpairAssistantHost.mockClear();
  pairingStartHost.mockClear();
  pairingPollHost.mockClear();
  pairingCancelHost.mockClear();
  clearGatewayToken();
  setSelfHostedConnection(null);
  useAssistantIdentityStore.getState().clearIdentity();
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

  test("loads a synthetic active assistant without calling the local host", async () => {
    window.__CADET_CONFIG__ = { remote: "docker" };

    const lockfile = await loadLockfile();

    expect(isCadetCloudRemote()).toBe(false);
    expect(loadLockfileHost).not.toHaveBeenCalled();
    expect(lockfile.activeAssistant).toBe("self");
    expect(lockfile.assistants).toEqual([
      expect.objectContaining({
        assistantId: "self",
        cloud: "local",
        name: "Local Assistant",
        runtimeUrl: window.location.origin,
      }),
    ]);
    expect(getLocalAssistants().map((a) => a.assistantId)).toEqual(["self"]);
    expect(getLocalGatewayUrl()).toBeUndefined();
    expect(useLockfileStore.getState().committed).toBe(true);
  });

  test("names the synthetic assistant from the injected config when present", async () => {
    window.__CADET_CONFIG__ = {
      remote: "docker",
      assistantName: "cadet-deep-hare-ww1iw1",
    };

    const lockfile = await loadLockfile();

    expect(lockfile.assistants).toEqual([
      expect.objectContaining({
        assistantId: "self",
        name: "cadet-deep-hare-ww1iw1",
      }),
    ]);
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
  function seedSessionResidue(): void {
    seedGatewayToken({
      token: "tok",
      expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 3600,
      source: "src",
    });
    setSelfHostedConnection({ url: "http://localhost/x", token: "tok" });
  }

  test("calls the host unpair and commits the returned lockfile", async () => {
    setLockfile({
      assistants: [localA, pairedEntry],
      activeAssistant: "local-a",
    });
    const resulting = { assistants: [localA], activeAssistant: "local-a" };
    unpairAssistantHost.mockResolvedValueOnce({
      ok: true as const,
      lockfile: resulting,
    });

    const result = await removePairedAssistantFromLockfile("paired-a");

    expect(result).toEqual({ ok: true });
    expect(unpairAssistantHost).toHaveBeenCalledWith("paired-a");
    expect(useLockfileStore.getState().lockfile).toEqual(resulting);
    expect(useLockfileStore.getState().committed).toBe(true);
  });

  test("refuses non-paired entries without calling the host", async () => {
    setLockfile({
      assistants: [localA, platform],
      activeAssistant: "local-a",
    });

    for (const id of ["local-a", "platform-a"]) {
      const result = await removePairedAssistantFromLockfile(id);
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    }
    expect(unpairAssistantHost).not.toHaveBeenCalled();
  });

  test("refuses an unknown id without calling the host", async () => {
    setLockfile({ assistants: [pairedEntry], activeAssistant: null });

    const result = await removePairedAssistantFromLockfile("nope");

    expect(result.ok).toBe(false);
    expect(unpairAssistantHost).not.toHaveBeenCalled();
  });

  test("propagates a host failure without committing or clearing session state", async () => {
    setLockfile({
      assistants: [localA, pairedEntry],
      activeAssistant: "local-a",
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
    expect(useLockfileStore.getState().committed).toBe(false);
    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBe(
      "paired-a",
    );
  });

  test("clears selection, gateway token, and self-hosted connection when removing the selected entry", async () => {
    setLockfile({
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
    expect(getGatewayToken()).toBeNull();
    expect(getSelfHostedIngressUrl()).toBeNull();
  });

  test("leaves session state alone when removing a non-selected entry", async () => {
    setLockfile({
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
    expect(getGatewayToken()).toBe("tok");
    expect(getSelfHostedIngressUrl()).toBe("http://localhost/x");
  });
});

describe("assistant pairing", () => {
  test("starts the attempt through the host without touching the lockfile", async () => {
    const result = await startAssistantPairing("https://gw.example.com");

    expect(pairingStartHost).toHaveBeenCalledWith("https://gw.example.com");
    expect(result).toMatchObject({ ok: true, handle: "handle-1" });
    expect(loadLockfileHost).not.toHaveBeenCalled();
  });

  test("an imported poll registers the pairing and reloads the lockfile", async () => {
    loadLockfileHost.mockImplementationOnce(async () => ({
      assistants: [pairedEntry],
      activeAssistant: null,
    }));

    const result = await pollAssistantPairing("handle-1", "desk");

    expect(pairingPollHost).toHaveBeenCalledWith("handle-1", "desk");
    expect(result).toEqual({
      ok: true,
      status: "imported",
      assistantId: "paired-new",
      accessOnly: false,
    });
    expect(loadLockfileHost).toHaveBeenCalledTimes(1);
    expect(
      useLockfileStore
        .getState()
        .lockfile?.assistants.map((a) => a.assistantId),
    ).toEqual(["paired-a"]);
    expect(useLockfileStore.getState().committed).toBe(true);
  });

  test("a pending poll passes the cadence through without reloading", async () => {
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

  test("returns the host error without reloading on failure", async () => {
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
      reason: "invalid-address",
      error: "That address is not usable.",
      rejection: "reason-from-a-newer-host",
    } as unknown as localModeHost.LocalPairingStartResult);

    const result = await startAssistantPairing("https://gw.example.com");

    expect(result).toEqual({
      ok: false,
      reason: "invalid-address",
      error: "That address is not usable.",
      rejection: undefined,
    });
  });

  test("an error-less host failure still reports something displayable", async () => {
    pairingStartHost.mockResolvedValueOnce({ ok: false, error: "" });

    const result = await startAssistantPairing("https://gw.example.com");

    expect(result).toEqual({
      ok: false,
      error: "Failed to connect to that assistant.",
    });
  });

  test("cancelling forwards the handle to the host", async () => {
    await cancelAssistantPairing("handle-1");

    expect(pairingCancelHost).toHaveBeenCalledWith("handle-1");
  });

  test("cancelling a session the host rejects resolves quietly", async () => {
    pairingCancelHost.mockRejectedValueOnce(new Error("no such session"));

    expect(await cancelAssistantPairing("handle-1")).toBeUndefined();
  });

  test.each([
    // Nothing reached the assistant, so the code is untouched.
    "unreachable",
    // The assistant refused with a status that released the code.
    "gateway-retryable",
  ] as const)("a %s failure is worth polling through", (reason) => {
    expect(
      isRetryablePairingFailure({ ok: false, reason, error: "not yet" }),
    ).toBe(true);
  });

  test.each([
    "invalid-address",
    "unknown-session",
    "expired",
    // The assistant answered with something unusable, past which the code is
    // spent rather than released.
    "gateway",
    "import",
  ] as const)("a %s failure ends the attempt", (reason) => {
    expect(isRetryablePairingFailure({ ok: false, reason, error: "no" })).toBe(
      false,
    );
  });

  test("a host too old to name a reason ends the attempt", () => {
    expect(isRetryablePairingFailure({ ok: false, error: "no" })).toBe(false);
  });
});

describe("loadLockfile host-failure fallback", () => {
  test("keeps the cached lockfile instead of clobbering it with empty", async () => {
    useLockfileStore
      .getState()
      .setLockfile({ assistants: [localA], activeAssistant: "local-a" });

    const result = await loadLockfile();

    expect(result.assistants).toEqual([localA]);
    expect(useLockfileStore.getState().lockfile?.assistants).toEqual([localA]);
    expect(useLockfileStore.getState().committed).toBe(true);
  });

  test("falls back to the persisted mirror when nothing is cached", async () => {
    localStorage.setItem(
      LOCKFILE_STORAGE_KEY,
      JSON.stringify({ assistants: [localA], activeAssistant: null }),
    );

    const result = await loadLockfile();

    expect(result.assistants.map((a) => a.assistantId)).toEqual(["local-a"]);
    expect(useLockfileStore.getState().committed).toBe(true);
  });

  test("records the empty fallback as not committed", async () => {
    const result = await loadLockfile();

    expect(result.assistants).toEqual([]);
    expect(useLockfileStore.getState().committed).toBe(false);
  });
});

describe("loadLockfile on a cloud-hosted cadet", () => {
  test("commits an empty lockfile without touching the local host", async () => {
    window.__CADET_CONFIG__ = { remote: "cloud" };
    useLockfileStore
      .getState()
      .setLockfile({ assistants: [localA], activeAssistant: "local-a" });

    const result = await loadLockfile();

    expect(loadLockfileHost).not.toHaveBeenCalled();
    expect(result.assistants).toEqual([]);
    expect(result.activeAssistant).toBeNull();
    expect(useLockfileStore.getState().committed).toBe(true);
  });

  test("a non-cloud remote still reads the host", async () => {
    window.__CADET_CONFIG__ = { remote: "local" };
    loadLockfileHost.mockImplementationOnce(async () => ({
      assistants: [localA],
      activeAssistant: "local-a",
    }));

    const result = await loadLockfile();

    expect(result.assistants.map((a) => a.assistantId)).toEqual(["local-a"]);
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
    // treating them as non-local. (Docker is still gateway-reachable; see the
    // isLocalGatewayAssistant tests.)
    const docker = { assistantId: "d", cloud: "docker" } as LockfileAssistant;
    const appleContainer = {
      assistantId: "a",
      cloud: "apple-container",
    } as LockfileAssistant;
    expect(isLocalAssistant(docker)).toBe(false);
    expect(isLocalAssistant(appleContainer)).toBe(false);
  });

  test("local and docker assistants are local-gateway assistants; others are not", () => {
    const docker = { assistantId: "d", cloud: "docker" } as LockfileAssistant;
    expect(isLocalGatewayAssistant(localA)).toBe(true);
    expect(isLocalGatewayAssistant(docker)).toBe(true);
    for (const cloud of ["apple-container", "cadet", "paired", "gcp"]) {
      const other = { assistantId: `o-${cloud}`, cloud } as LockfileAssistant;
      expect(isLocalGatewayAssistant(other)).toBe(false);
    }
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
    for (const cloud of ["paired", "gcp", "aws", "custom"]) {
      const remote = { assistantId: `r-${cloud}`, cloud } as LockfileAssistant;
      expect(isLocalAssistant(remote)).toBe(false);
      expect(isCloudAssistant(remote)).toBe(false);
    }
  });

  test("only paired-cloud entries are paired assistants", () => {
    expect(isPairedAssistant({ cloud: "paired" })).toBe(true);
    for (const cloud of ["local", "docker", "cadet", undefined]) {
      expect(isPairedAssistant({ cloud })).toBe(false);
    }
  });

  test("getLocalAssistants / getCloudAssistants partition by cloud, excluding remote", () => {
    const paired = {
      assistantId: "paired-a",
      cloud: "paired",
    } as LockfileAssistant;
    setLockfile({
      assistants: [localA, platform, paired],
      activeAssistant: null,
    });
    expect(getLocalAssistants()).toEqual([localA]);
    expect(getCloudAssistants()).toEqual([platform]);
  });
});

describe("getLocalGatewayUrl", () => {
  test("resolves the gateway proxy URL for a local assistant with a recorded port", () => {
    enableLocalMode();
    expect(getLocalGatewayUrl(localA)).toBe("/assistant/__gateway/local-a");
  });

  test("is undefined for a local assistant with no recorded gateway port", () => {
    enableLocalMode();
    const portless = { assistantId: "x", cloud: "local" } as LockfileAssistant;
    expect(getLocalGatewayUrl(portless)).toBeUndefined();
  });

  test("resolves a docker assistant's gateway from its loopback runtimeUrl", () => {
    // Docker entries record the published gateway as a loopback runtimeUrl and
    // carry no `resources` block.
    enableLocalMode();
    const docker = {
      assistantId: "dk",
      cloud: "docker",
      runtimeUrl: "http://localhost:7930",
    } as LockfileAssistant;
    expect(getLocalGatewayUrl(docker)).toBe("/assistant/__gateway/dk");
  });

  test("accepts 127.0.0.1 as a loopback runtimeUrl host", () => {
    enableLocalMode();
    const docker = {
      assistantId: "dk",
      cloud: "docker",
      runtimeUrl: "http://127.0.0.1:7931",
    } as LockfileAssistant;
    expect(getLocalGatewayUrl(docker)).toBe("/assistant/__gateway/dk");
  });

  test("prefers a recorded resources.gatewayPort over the runtimeUrl port", () => {
    enableLocalMode();
    const entry = {
      assistantId: "x",
      cloud: "local",
      runtimeUrl: "http://localhost:9999",
      resources: { gatewayPort: 7830 },
    } as LockfileAssistant;
    expect(getLocalGatewayUrl(entry)).toBe("/assistant/__gateway/x");
  });

  test("never resolves a gateway from a non-loopback runtimeUrl", () => {
    enableLocalMode();
    const docker = {
      assistantId: "dk",
      cloud: "docker",
      runtimeUrl: "http://assistant.example.com:7930",
    } as LockfileAssistant;
    expect(getLocalGatewayUrl(docker)).toBeUndefined();
  });

  test("is undefined for a docker assistant with no runtimeUrl or port", () => {
    enableLocalMode();
    const bare = { assistantId: "dk", cloud: "docker" } as LockfileAssistant;
    expect(getLocalGatewayUrl(bare)).toBeUndefined();
  });

  test("is undefined for a cloud assistant", () => {
    enableLocalMode();
    expect(getLocalGatewayUrl(platform)).toBeUndefined();
  });

  test("is undefined for a remote (paired) assistant", () => {
    enableLocalMode();
    const paired = { assistantId: "p", cloud: "paired" } as LockfileAssistant;
    expect(getLocalGatewayUrl(paired)).toBeUndefined();
  });

  test("is undefined outside local mode even for a local assistant with a port", () => {
    disableLocalMode();
    expect(getLocalGatewayUrl(localA)).toBeUndefined();
  });
});

describe("getPairedGatewayUrl", () => {
  test("resolves the same-origin proxy path for a usable paired entry", () => {
    enableLocalMode();
    expect(getPairedGatewayUrl(pairedEntry)).toBe(
      "/assistant/__gateway/paired-a",
    );
  });

  test("URL-encodes the assistant id in the proxy path", () => {
    enableLocalMode();
    const paired = {
      ...pairedEntry,
      assistantId: "paired/one two",
    } as LockfileAssistant;
    expect(getPairedGatewayUrl(paired)).toBe(
      "/assistant/__gateway/paired%2Fone%20two",
    );
  });

  test("accepts runtimeUrls with trailing slashes or path prefixes", () => {
    enableLocalMode();
    for (const runtimeUrl of [
      "https://gw.example.com///",
      "https://gw.example.com/assistant/",
    ]) {
      const paired = { ...pairedEntry, runtimeUrl } as LockfileAssistant;
      expect(getPairedGatewayUrl(paired)).toBe(
        "/assistant/__gateway/paired-a",
      );
    }
  });

  test("is undefined for a non-http(s) runtimeUrl", () => {
    enableLocalMode();
    const paired = {
      ...pairedEntry,
      runtimeUrl: "ftp://x",
    } as LockfileAssistant;
    expect(getPairedGatewayUrl(paired)).toBeUndefined();
  });

  test("is undefined for a missing or malformed runtimeUrl", () => {
    enableLocalMode();
    const missing = { assistantId: "p", cloud: "paired" } as LockfileAssistant;
    const malformed = {
      ...pairedEntry,
      runtimeUrl: "not a url",
    } as LockfileAssistant;
    expect(getPairedGatewayUrl(missing)).toBeUndefined();
    expect(getPairedGatewayUrl(malformed)).toBeUndefined();
  });

  test("is undefined for non-paired entries", () => {
    enableLocalMode();
    expect(getPairedGatewayUrl(localA)).toBeUndefined();
    expect(getPairedGatewayUrl(platform)).toBeUndefined();
    expect(getPairedGatewayUrl(undefined)).toBeUndefined();
  });

  test("is undefined outside local mode", () => {
    disableLocalMode();
    expect(getPairedGatewayUrl(pairedEntry)).toBeUndefined();
  });

  test("is undefined in remote-gateway mode", () => {
    enableLocalMode();
    window.__CADET_CONFIG__ = { remote: "docker" };
    expect(getPairedGatewayUrl(pairedEntry)).toBeUndefined();
  });
});

describe("getAuthGatewayIngressUrl", () => {
  test("returns origin + gateway proxy for a local entry", () => {
    enableLocalMode();
    expect(getAuthGatewayIngressUrl(localA)).toBe(
      `${window.location.origin}/assistant/__gateway/local-a`,
    );
  });

  test("returns origin + paired gateway proxy for a paired entry", () => {
    enableLocalMode();
    expect(getAuthGatewayIngressUrl(pairedEntry)).toBe(
      `${window.location.origin}/assistant/__gateway/paired-a`,
    );
  });

  test("is undefined for a cloud entry", () => {
    enableLocalMode();
    expect(getAuthGatewayIngressUrl(platform)).toBeUndefined();
  });

  test("resolves the selected assistant's ingress", () => {
    enableLocalMode();
    setLockfile({ assistants: [pairedEntry], activeAssistant: "paired-a" });
    expect(getAuthGatewayIngressUrl(getSelectedAssistant())).toBe(
      `${window.location.origin}/assistant/__gateway/paired-a`,
    );
  });
});

describe("isCliWakeableAssistant", () => {
  test("a cloud:local entry with no recorded port is wakeable (wake establishes it)", () => {
    setLockfile({
      assistants: [
        { assistantId: "legacy", cloud: "local" } as LockfileAssistant,
      ],
      activeAssistant: "legacy",
    });
    expect(isCliWakeableAssistant("legacy")).toBe(true);
  });

  test("a legacy (cloud-less) entry is wakeable once normalized at parse", () => {
    setLockfile(
      parseLockfile({
        assistants: [{ assistantId: "old" }],
        activeAssistant: "old",
      }),
    );
    expect(isCliWakeableAssistant("old")).toBe(true);
  });

  test("a docker-cloud entry is not CLI-wakeable", () => {
    setLockfile({
      assistants: [{ assistantId: "dk", cloud: "docker" } as LockfileAssistant],
      activeAssistant: "dk",
    });
    expect(isCliWakeableAssistant("dk")).toBe(false);
  });

  test("a cloud (cadet) entry is not CLI-wakeable", () => {
    setLockfile({ assistants: [platform], activeAssistant: "platform-a" });
    expect(isCliWakeableAssistant("platform-a")).toBe(false);
  });

  test("an unknown id is not wakeable", () => {
    setLockfile({ assistants: [localA], activeAssistant: "local-a" });
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

  test("throws UnresolvedPairedGatewayError for a paired assistant with no runtimeUrl", async () => {
    enableLocalMode();
    const paired = { assistantId: "p", cloud: "paired" } as LockfileAssistant;
    await expect(primeLocalGatewayConnection(paired)).rejects.toBeInstanceOf(
      UnresolvedPairedGatewayError,
    );
  });

  test("throws UnresolvedPairedGatewayError for a paired assistant with a non-http runtimeUrl", async () => {
    enableLocalMode();
    const paired = {
      ...pairedEntry,
      runtimeUrl: "ftp://x",
    } as LockfileAssistant;
    await expect(primeLocalGatewayConnection(paired)).rejects.toBeInstanceOf(
      UnresolvedPairedGatewayError,
    );
  });

  test("paired prime reaches the host proxy without exposing a bearer", async () => {
    enableLocalMode();
    setLockfile({ assistants: [pairedEntry], activeAssistant: "paired-a" });
    seedGatewayToken({
      token: "legacy-paired-guardian",
      expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 3600,
      source: "/assistant/__gateway/paired-a/auth/token",
    });
    const fetchSpy = mock(async () =>
      Response.json({ status: "ok", ready: true }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await primeLocalGatewayConnection(pairedEntry);

    expect(fetchSpy).toHaveBeenCalledWith(
      "/assistant/__gateway/paired-a/readyz",
    );
    expect(fetchGuardianTokenHost).not.toHaveBeenCalled();
    expect(getGatewayToken()).toBeNull();
    // The connection rides the same-origin host proxy, never the remote
    // runtimeUrl directly (packaged-app CSP and browser CORS both block it).
    expect(getSelfHostedIngressUrl()).toBe(
      `${window.location.origin}/assistant/__gateway/paired-a`,
    );
    expect(getSelfHostedActorToken()).toBeNull();
    expect(isGatewayAuthMode()).toBe(true);
    expect(localStorage.getItem("cadet:gw:token")).toBeNull();
    expect(localStorage.getItem("cadet:gw:tokenSource")).toBeNull();
  });

  test("paired re-prime keeps the connection live while the readiness probe is in flight", async () => {
    // A re-prime of the assistant the slot already points at must not open a
    // window in which the slot is empty: requests issued then would fall
    // through to the cloud and gateway-auth predicates would read false.
    enableLocalMode();
    setLockfile({ assistants: [pairedEntry], activeAssistant: "paired-a" });
    const ingressUrl = `${window.location.origin}/assistant/__gateway/paired-a`;
    setSelfHostedConnection({ url: ingressUrl, token: null });

    let ingressDuringProbe: string | null | undefined;
    let authModeDuringProbe: boolean | undefined;
    globalThis.fetch = mock(async () => {
      ingressDuringProbe = getSelfHostedIngressUrl();
      authModeDuringProbe = isGatewayAuthMode();
      return Response.json({ status: "ok", ready: true });
    }) as unknown as typeof fetch;

    await primeLocalGatewayConnection(pairedEntry);

    expect(ingressDuringProbe).toBe(ingressUrl);
    expect(authModeDuringProbe).toBe(true);
    expect(getSelfHostedIngressUrl()).toBe(ingressUrl);
  });

  test("paired prime surfaces a host credential failure without reading it directly", async () => {
    enableLocalMode();
    setLockfile({ assistants: [pairedEntry], activeAssistant: "paired-a" });
    globalThis.fetch = mock(async () =>
      Response.json({ status: "ok", ready: true }),
    ) as unknown as typeof fetch;
    await primeLocalGatewayConnection(pairedEntry);
    expect(isGatewayAuthMode()).toBe(true);

    globalThis.fetch = mock(
      async () => new Response("Guardian token not found", { status: 404 }),
    ) as unknown as typeof fetch;

    const error = await primeLocalGatewayConnection(pairedEntry).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(localModeHost.GuardianTokenError);
    expect((error as localModeHost.GuardianTokenError).status).toBe(404);
    expect(fetchGuardianTokenHost).not.toHaveBeenCalled();
    expect(isGatewayAuthMode()).toBe(false);
  });

  test("unready paired prime preserves the current local session", async () => {
    enableLocalMode();
    setLockfile({
      assistants: [localA, pairedEntry],
      activeAssistant: "local-a",
    });
    setSelected("local-a");
    seedGatewayToken({
      token: "local-actor-token",
      expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 3600,
      source: "/assistant/__gateway/7830/auth/token",
    });
    setSelfHostedConnection({
      url: `${window.location.origin}/assistant/__gateway/local-a`,
      token: "local-actor-token",
    });
    globalThis.fetch = mock(async () =>
      Response.json({ status: "migrating", ready: false }),
    ) as unknown as typeof fetch;

    await expect(primeLocalGatewayConnection(pairedEntry)).rejects.toThrow(
      "Paired assistant is not ready",
    );

    expect(getGatewayToken()).toBe("local-actor-token");
    expect(getSelfHostedIngressUrl()).toBe(
      `${window.location.origin}/assistant/__gateway/local-a`,
    );
    expect(getSelfHostedActorToken()).toBe("local-actor-token");
    expect(isGatewayAuthMode()).toBe(true);
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

describe("getActiveAssistant", () => {
  test("returns the entry matching the recorded active id", () => {
    setLockfile({ assistants: [localA, localB], activeAssistant: "local-b" });
    expect(getActiveAssistant()).toBe(localB);
  });

  test("returns the sole assistant when the active id is stale", () => {
    setLockfile({ assistants: [localA], activeAssistant: "gone" });
    expect(getActiveAssistant()).toBe(localA);
  });

  test("returns undefined when the active id is stale and the choice is ambiguous", () => {
    setLockfile({ assistants: [localA, localB], activeAssistant: "gone" });
    expect(getActiveAssistant()).toBeUndefined();
  });

  test("does not bind to the first entry when a later one is active", () => {
    setLockfile({ assistants: [localA, localB], activeAssistant: "local-b" });
    expect(getActiveAssistant()).not.toBe(localA);
  });
});

describe("reconcileSelectedAssistant", () => {
  test("clears a stale selection whose id is absent from the lockfile", () => {
    setLockfile({ assistants: [localA], activeAssistant: "local-a" });
    setSelected("local-b");

    reconcileSelectedAssistant();

    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBeNull();
    expect(getSelectedAssistant()).toBe(localA);
  });

  test("preserves a selection that is still present in the lockfile", () => {
    setLockfile({ assistants: [localA, localB], activeAssistant: "local-a" });
    setSelected("local-b");

    reconcileSelectedAssistant();

    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBe(
      "local-b",
    );
    expect(getSelectedAssistant()).toBe(localB);
  });

  test("is a no-op when there is no tab-local selection", () => {
    setLockfile({ assistants: [localA], activeAssistant: "local-a" });

    reconcileSelectedAssistant();

    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBeNull();
  });

  test("a transient empty-lockfile read does not clear the selection", () => {
    // No cached lockfile and nothing persisted → getLockfile() hits its empty
    // fallback (setCachedLockfile), which must NOT reconcile. Otherwise a boot/
    // read failure would wrongly drop a still-valid selection.
    setSelected("local-a");

    getLockfile();

    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBe(
      "local-a",
    );
  });
});

describe("getLockfile persisted-storage read", () => {
  test("validates the persisted lockfile, salvaging usable entries", () => {
    localStorage.setItem(
      LOCKFILE_STORAGE_KEY,
      JSON.stringify({
        activeAssistant: "local-a",
        assistants: [
          { assistantId: "local-a", cloud: "local" },
          { cloud: "local" },
        ],
      }),
    );
    const lockfile = getLockfile();
    expect(lockfile.activeAssistant).toBe("local-a");
    expect(lockfile.assistants).toEqual([
      { assistantId: "local-a", cloud: "local" },
    ]);
  });

  test("falls back to an empty lockfile when the stored value is not JSON", () => {
    localStorage.setItem(LOCKFILE_STORAGE_KEY, "{not json");
    expect(getLockfile()).toEqual({ assistants: [], activeAssistant: null });
  });
});
