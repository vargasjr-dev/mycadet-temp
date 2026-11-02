import { afterEach, expect, test } from "bun:test";

import {
  __resetLocalLockfileForTesting,
  useLocalLockfileStore,
} from "./local-lockfile-store";

type FixtureLockfile = {
  assistants: Array<Record<string, unknown>>;
  activeAssistant: string | null;
};

const realFetch = globalThis.fetch;

/**
 * The serving host answers the roster read through its operator route; the
 * test stubs that fetch. No availability gate arms it — the read runs
 * unconditionally, and a failure settles the store empty.
 */
function stubHost(lockfile: FixtureLockfile | null): void {
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: { platform: "electron" },
  });
  globalThis.fetch = (async () => {
    if (lockfile === null) {
      return new Response("unreadable", { status: 500 });
    }
    return new Response(JSON.stringify(lockfile), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function clearHost(): void {
  delete (window as { cadet?: unknown }).cadet;
  globalThis.fetch = realFetch;
}

afterEach(() => {
  clearHost();
  __resetLocalLockfileForTesting();
});

test("load publishes the parsed lockfile and marks the store loaded", async () => {
  stubHost({
    assistants: [
      {
        assistantId: "paired-1",
        name: "Office",
        cloud: "paired",
        runtimeUrl: "https://office.example.com",
      },
    ],
    activeAssistant: null,
  });
  await useLocalLockfileStore.load();
  expect(useLocalLockfileStore.getState().loaded).toBe(true);
  expect(useLocalLockfileStore.getState().lockfile?.assistants).toHaveLength(1);
});

test("a failed read still settles loaded, keeping the arm renderable", async () => {
  stubHost(null);
  await useLocalLockfileStore.load();
  expect(useLocalLockfileStore.getState().loaded).toBe(true);
  expect(useLocalLockfileStore.getState().lockfile).toBeNull();
});

test("with no serving host the store loads empty instead of throwing", async () => {
  clearHost();
  await useLocalLockfileStore.load();
  expect(useLocalLockfileStore.getState().loaded).toBe(true);
  expect(useLocalLockfileStore.getState().lockfile).toBeNull();
});
