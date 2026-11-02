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
 * The desktop serves the lockfile read through its operator route; the test
 * stubs that fetch. The `cadet.platform` stamp arms the availability gate,
 * and a stale shell's dead bridge — when installed — must never be consulted.
 */
function stubHost(
  lockfile: FixtureLockfile | null,
  options: { staleBridge?: boolean } = {},
): void {
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: {
      platform: "electron",
      ...(options.staleBridge
        ? {
            localMode: new Proxy(
              {},
              {
                get: () => {
                  throw new Error(
                    "the localMode bridge must never be consulted",
                  );
                },
              },
            ),
          }
        : {}),
    },
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

test("a stale shell's dead bridge is never consulted", async () => {
  stubHost(
    {
      assistants: [
        { assistantId: "local-1", name: "Home", cloud: "local", port: 7830 },
      ],
      activeAssistant: null,
    },
    { staleBridge: true },
  );
  await useLocalLockfileStore.load();
  expect(useLocalLockfileStore.getState().loaded).toBe(true);
  expect(useLocalLockfileStore.getState().lockfile?.assistants).toHaveLength(1);
});

test("with no local-mode host the store loads empty instead of throwing", async () => {
  stubHost(null);
  clearHost();
  await useLocalLockfileStore.load();
  expect(useLocalLockfileStore.getState().loaded).toBe(true);
  expect(useLocalLockfileStore.getState().lockfile).toBeNull();
});
