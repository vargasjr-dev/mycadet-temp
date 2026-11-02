import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { parseLockfile } from "@mycadet/local-mode/contract";

import {
  getActiveAssistant,
  getServedLockfile,
  getRemoteAssistantDisplayName,
  isLocalAssistant,
  isCadetCloudRemote,
} from "@/lib/local-mode";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import { SELECTED_ASSISTANT_STORAGE_KEY } from "@/assistant/selected-assistant-storage";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const realFetch = globalThis.fetch;

function setSelected(id: string): void {
  localStorage.setItem(SELECTED_ASSISTANT_STORAGE_KEY, id);
}

// Tests default to cloud-served mode (test-setup.ts stamps the config), but
// this file's local paths need the local arm: every test starts stamped
// local, the cloud/served-gateway descriptions override per test, and the
// afterEach restores the suite default.
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
  setSelfHostedConnection(null);
  useAssistantIdentityStore.getState().clearIdentity();
});

const localA: LockfileAssistant = {
  assistantId: "local-a",
  cloud: "local",
  port: 7830,
  daemonPort: 7831,
} as LockfileAssistant;

const platform: LockfileAssistant = {
  assistantId: "platform-a",
  cloud: "cloud",
} as LockfileAssistant;

describe("served config synthesis", () => {
  test("the stamp produces the one assistant, straight from the injected config", () => {
    stampServed({ assistantId: "served-1", assistantName: "Served" });

    const lockfile = getServedLockfile();

    expect(lockfile.activeAssistant).toBe("served-1");
    expect(lockfile.assistants).toEqual([
      expect.objectContaining({
        assistantId: "served-1",
        cloud: "local",
        name: "Served",
      }),
    ]);
  });

  test("a host that stamps no assistant yields the empty lockfile (pre-hatch)", () => {
    window.__CADET_CONFIG__ = { remote: "local" };

    expect(getServedLockfile()).toEqual({
      assistants: [],
      activeAssistant: null,
    });
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

    stampServed({ assistantId: "served-1", remote: "docker" });
    expect(getServedLockfile().assistants[0]?.cloud).toBe("docker");
  });

  test("the served entry carries no runtimeUrl and no real port", () => {
    stampServed({ assistantId: "served-1" });

    const entry = getServedLockfile().assistants[0];
    expect(entry?.cloud === "local" ? entry.port : undefined).toBe(0);
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
    expect(lockfile.activeAssistant).toBe("edge-1");
    expect(lockfile.assistants).toEqual([
      expect.objectContaining({
        assistantId: "edge-1",
        cloud: "docker",
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

describe("assistant classification", () => {
  test("a cadet-cloud entry is not local", () => {
    expect(isLocalAssistant(platform)).toBe(false);
  });

  test("a local-cloud entry with a gateway port is local, not platform", () => {
    expect(isLocalAssistant(localA)).toBe(true);
  });

  test("a local-cloud entry without a gateway port is still local (identity, not connectivity)", () => {
    const portless = { assistantId: "x", cloud: "local" } as LockfileAssistant;
    expect(isLocalAssistant(portless)).toBe(true);
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

  test("a remote self-hosted cloud is not local", () => {
    const remote = {
      assistantId: "r-custom",
      cloud: "custom",
    } as LockfileAssistant;
    expect(isLocalAssistant(remote)).toBe(false);
  });
});
