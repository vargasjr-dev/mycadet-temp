import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { isCadetCloudRemote } from "@/lib/local-mode";
import { SELECTED_ASSISTANT_STORAGE_KEY } from "@/assistant/selected-assistant-storage";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const realFetch = globalThis.fetch;

beforeEach(() => {
  window.__CADET_CONFIG__ = { remote: "local" };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  window.__CADET_CONFIG__ = { remote: "cloud" };
  localStorage.removeItem(SELECTED_ASSISTANT_STORAGE_KEY);
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("isCadetCloudRemote", () => {
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
});
