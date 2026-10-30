/**
 * Unit tests for `resolveSelectedAssistantId` — the unified read path shared by
 * platform and local selection. There is ONE selection; the org is a read-time
 * filter. Covers the resolution order: valid selected id → drop wrong-org →
 * lockfile activeAssistant → first valid, plus the hydration-gated pass-through
 * for an unknown id.
 *
 * bun's `mock.module` is process-global, so this file must run on its own.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ResolvedAssistant } from "@/stores/resolved-assistants-store";
import type { LockfileAssistant } from "@/runtime/local-mode-host";

const ORG_A = "org-a";

// Mutable fixtures the mocks read so each test can stage its own world.
let assistants: ResolvedAssistant[] = [];
let selectedAssistantId: string | null = null;
let assistantsHydrated = true;
let activeLocal: LockfileAssistant | undefined;

const storeSetSelectedAssistantMock = mock((_id: string | null) => {});
mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    getState: () => ({
      assistants,
      selectedAssistantId,
      assistantsHydrated,
      setSelectedAssistant: storeSetSelectedAssistantMock,
    }),
  },
}));
mock.module("@/lib/local-mode", () => ({
  getActiveAssistant: () => activeLocal,
  isLocalClient: () => false,
  isServedGatewayRuntime: () => false,
}));

const { resolveSelectedAssistantId, setSelectedAssistant } =
  await import("./selection");

function cloudAssistant(
  id: string,
  organizationId?: string,
): ResolvedAssistant {
  return {
    id,
    organizationId,
  };
}

function lockfileAssistant(assistantId: string): LockfileAssistant {
  return {
    assistantId,
    cloud: "cloud",
    runtimeUrl: "http://x",
    hatchedAt: "2026-01-01",
  } as LockfileAssistant;
}

beforeEach(() => {
  assistants = [];
  selectedAssistantId = null;
  assistantsHydrated = true;
  activeLocal = undefined;
  storeSetSelectedAssistantMock.mockClear();
});

describe("resolveSelectedAssistantId", () => {
  test("valid selected id passes through", () => {
    assistants = [cloudAssistant("asst-1", ORG_A)];
    selectedAssistantId = "asst-1";
    expect(resolveSelectedAssistantId()).toBe("asst-1");
  });

  test("empty selection falls back to lockfile activeAssistant when valid", () => {
    assistants = [cloudAssistant("asst-1", ORG_A)];
    activeLocal = lockfileAssistant("asst-1");
    expect(resolveSelectedAssistantId()).toBe("asst-1");
  });

  test("empty selection + stale active falls back to first valid assistant", () => {
    assistants = [cloudAssistant("asst-1", ORG_A)];
    // active id no longer resolves to a valid entry for this org.
    activeLocal = lockfileAssistant("asst-stale");
    expect(resolveSelectedAssistantId()).toBe("asst-1");
  });

  test("unknown selected id passes through while NOT hydrated (pre-load)", () => {
    // The list may simply not have arrived yet, so don't drop the selection.
    assistantsHydrated = false;
    assistants = [];
    selectedAssistantId = "asst-unknown";
    expect(resolveSelectedAssistantId()).toBe("asst-unknown");
  });

  test("unknown selected id is a ghost once hydrated and falls through", () => {
    // Regression for the ghost bug: a hydrated list that doesn't contain the
    // selection means it's genuinely gone — fall through, never return it.
    assistantsHydrated = true;
    assistants = [cloudAssistant("asst-1", ORG_A)];
    selectedAssistantId = "asst-unknown";
    expect(resolveSelectedAssistantId()).toBe("asst-1");
  });

  test("hydrated unknown selection with no valid assistants resolves to null", () => {
    assistantsHydrated = true;
    assistants = [];
    selectedAssistantId = "asst-unknown";
    expect(resolveSelectedAssistantId()).toBeNull();
  });

  test("a stale lockfile active with no resolved entry is NOT passed through", () => {
    // Regression: the lockfile active must go through validation, not the
    // unknown-id pass-through — otherwise a stale active 404-loops forever.
    assistants = [cloudAssistant("asst-1", ORG_A)];
    activeLocal = lockfileAssistant("asst-stale");
    expect(resolveSelectedAssistantId()).toBe("asst-1");
  });
});

describe("setSelectedAssistant", () => {
  test("an id records the selection", async () => {
    await setSelectedAssistant("asst-1");

    expect(storeSetSelectedAssistantMock).toHaveBeenCalledWith("asst-1");
  });

  test("null clears the selection", async () => {
    await setSelectedAssistant(null);

    expect(storeSetSelectedAssistantMock).toHaveBeenCalledWith(null);
  });
});
