import { afterEach, expect, test } from "bun:test";

import {
  __resetLocalLockfileForTesting,
  useLocalLockfileStore,
} from "./local-lockfile-store";

type BridgeLockfile = {
  assistants: Array<Record<string, unknown>>;
  activeAssistant: string | null;
};

function stubBridge(lockfile: BridgeLockfile | null): void {
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: {
      platform: "electron",
      localMode: {
        readLockfile: async () => {
          if (lockfile === null) {
            throw new Error("lockfile unreadable");
          }
          return lockfile;
        },
      },
    },
  });
}

function clearBridge(): void {
  delete (window as { cadet?: unknown }).cadet;
}

afterEach(() => {
  clearBridge();
  __resetLocalLockfileForTesting();
});

test("load publishes the parsed lockfile and marks the store loaded", async () => {
  stubBridge({
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
  stubBridge(null);
  await useLocalLockfileStore.load();
  expect(useLocalLockfileStore.getState().loaded).toBe(true);
  expect(useLocalLockfileStore.getState().lockfile).toBeNull();
});

test("with no bridge the store loads empty instead of throwing", async () => {
  await useLocalLockfileStore.load();
  expect(useLocalLockfileStore.getState().loaded).toBe(true);
  expect(useLocalLockfileStore.getState().lockfile).toBeNull();
});
