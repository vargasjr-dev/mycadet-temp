/**
 * Unit tests for the retire service. The point of extracting it from the
 * settings component was so a retire can run for an arbitrary assistant id
 * (e.g. the tray "Retire <assistant>…" command) and route local-vs-platform by
 * the *target* assistant rather than the currently selected one. These tests
 * pin that routing plus the failure/404/cleanup behavior.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

// --- mutable mock state (set per test) --- //

let isLocalClientValue = false;
let lockfileAssistants: Array<{ assistantId: string; cloud?: string }> = [];
let storeAssistants: Array<{ id: string }> = [];
let retireByIdResult:
  | { ok: true }
  | { ok: false; status: number; error: Record<string, unknown> } = {
  ok: true,
};
let retireLocalResult: { ok: true } | { ok: false; error?: string } = {
  ok: true,
};

// --- module mocks --- //

const retireAssistantByIdMock = mock(
  async (_id: string, _options?: { successorAssistantId?: string }) =>
    retireByIdResult,
);
const listAssistantsMock = mock(async () => ({
  ok: true as const,
  status: 200,
  data: [{ id: "p1", is_local: false, created: "" }],
}));
mock.module("@/assistant/api", () => ({
  retireAssistantById: retireAssistantByIdMock,
  listAssistants: listAssistantsMock,
}));

const retireLocalAssistantMock = mock(async (_id: string) => retireLocalResult);
mock.module("@/lib/local-mode", () => ({
  getLockfile: () => ({
    assistants: lockfileAssistants,
    activeAssistant: null,
  }),
  isLocalAssistant: (a: { cloud?: string }) => a.cloud === "local",
  isLocalClient: () => isLocalClientValue,
  isPairedAssistant: (a: { cloud?: string }) => a.cloud === "paired",
  retireLocalAssistant: retireLocalAssistantMock,
}));
const forgetAssistantAvatarMock = mock((_qc: QueryClient, _id: string) => {});
mock.module("@/hooks/use-chooser-row-avatar", () => ({
  forgetAssistantAvatar: forgetAssistantAvatarMock,
}));
const queryClient = new QueryClient();
mock.module("@/stores/organization-store", () => ({
  useOrganizationStore: {
    getState: () => ({ currentOrganizationId: "org-test" }),
  },
}));
mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    getState: () => ({ user: { id: "user-1" } }),
  },
}));

const clearResearchSnapshotMock = mock((_userId: string | null) => {});
mock.module("@/domains/onboarding/research-onboarding-persistence", () => ({
  clearResearchSnapshot: clearResearchSnapshotMock,
}));

mock.module("@/lib/navigation/navigation-resolver", () => ({
  resolveNavigation: (
    state: Record<string, unknown>,
    query: { kind: string },
  ) => {
    if (query.kind !== "post-retire") {
      return { action: "allow" };
    }
    if (state.hasAssistants) {
      return { action: "redirect", to: "/assistant" };
    }
    if (!state.isLocalClient) {
      return { action: "redirect", to: "/assistant/onboarding/privacy" };
    }
    if (state.cloudSession === "present") {
      return { action: "redirect", to: "/assistant/onboarding/hosting" };
    }
    return { action: "redirect", to: "/assistant/welcome" };
  },
}));
mock.module("@/lib/navigation/build-state", () => ({
  buildNavigationState: () => ({
    isLocalClient: isLocalClientValue,
    isAuthenticated: false,
    cloudSession: "absent",
    hasAssistants: storeAssistants.length > 0,
  }),
}));

const removeMock = mock((assistantId: string) => {
  storeAssistants = storeAssistants.filter((a) => a.id !== assistantId);
});
mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    getState: () => ({ remove: removeMock }),
  },
}));

mock.module("@/utils/routes", () => ({
  routes: {
    assistant: "/assistant",
    welcome: "/assistant/welcome",
    onboarding: {
      hosting: "/assistant/onboarding/hosting",
      privacy: "/assistant/onboarding/privacy",
    },
  },
}));

const { retireAssistant } = await import("./retire-service");

beforeEach(() => {
  isLocalClientValue = false;
  lockfileAssistants = [];
  storeAssistants = [];
  retireByIdResult = { ok: true };
  retireLocalResult = { ok: true };
  retireAssistantByIdMock.mockClear();
  listAssistantsMock.mockClear();
  retireLocalAssistantMock.mockClear();
  forgetAssistantAvatarMock.mockClear();
  removeMock.mockClear();
  clearResearchSnapshotMock.mockClear();
});

afterEach(() => {
  // keep mock state isolated between tests
});

describe("retireAssistant", () => {
  test("platform assistant hands its OAuth connections to the successor", async () => {
    // GIVEN a cloud-hosted source and a teleport target to inherit from it
    lockfileAssistants = [{ assistantId: "p1", cloud: "cadet" }];
    storeAssistants = [{ id: "p1" }];

    // WHEN retiring it with a successor
    const outcome = await retireAssistant(queryClient, "p1", {
      successorAssistantId: "succ",
    });

    // THEN the cloud delete names the successor
    expect(retireAssistantByIdMock).toHaveBeenCalledWith("p1", {
      successorAssistantId: "succ",
    });
    expect(outcome.ok).toBe(true);
  });

  test("local assistant ignores a successor: the host CLI retires it", async () => {
    // GIVEN a local source in local mode
    isLocalClientValue = true;
    lockfileAssistants = [{ assistantId: "l1", cloud: "local" }];
    storeAssistants = [{ id: "l1" }];

    // WHEN retiring it with a successor
    const outcome = await retireAssistant(queryClient, "l1", {
      successorAssistantId: "succ",
    });

    // THEN the local path ran and the cloud delete was never called
    expect(retireLocalAssistantMock).toHaveBeenCalledWith("l1");
    expect(retireAssistantByIdMock).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
  });

  test("platform assistant routes through the cloud delete by id", async () => {
    // GIVEN a cloud-hosted target in web mode
    lockfileAssistants = [{ assistantId: "p1", cloud: "cadet" }];
    storeAssistants = [{ id: "p1" }];

    // WHEN retiring it
    const outcome = await retireAssistant(queryClient, "p1");

    // THEN the cloud delete ran with that id and the local path did not
    expect(retireAssistantByIdMock).toHaveBeenCalledWith("p1", {});
    expect(retireLocalAssistantMock).not.toHaveBeenCalled();
    expect(forgetAssistantAvatarMock).toHaveBeenCalledWith(queryClient, "p1");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.nextRoute).toBe("/assistant/onboarding/privacy");
    }
  });

  test("a successful retire drops the research-onboarding resume snapshot", async () => {
    // GIVEN a cloud-hosted target
    lockfileAssistants = [{ assistantId: "p1", cloud: "cadet" }];
    storeAssistants = [{ id: "p1" }];

    // WHEN retiring it
    const outcome = await retireAssistant(queryClient, "p1");

    // THEN the saved onboarding journey is discarded — a later onboarding must
    // start at the form, not resume the retired assistant's run deep in the
    // flow (e.g. straight onto the wake gate).
    expect(outcome.ok).toBe(true);
    expect(clearResearchSnapshotMock).toHaveBeenCalledWith("user-1");
  });

  test("a failed retire keeps the research-onboarding resume snapshot", async () => {
    // GIVEN the cloud delete fails terminally
    lockfileAssistants = [{ assistantId: "p1", cloud: "cadet" }];
    storeAssistants = [{ id: "p1" }];
    retireByIdResult = { ok: false, status: 500, error: { detail: "boom" } };

    // WHEN retiring it
    const outcome = await retireAssistant(queryClient, "p1");

    // THEN the journey survives — the assistant still exists.
    expect(outcome.ok).toBe(false);
    expect(clearResearchSnapshotMock).not.toHaveBeenCalled();
  });

  test("local assistant in local mode routes through the local retire", async () => {
    // GIVEN a local target in local mode
    isLocalClientValue = true;
    lockfileAssistants = [{ assistantId: "l1", cloud: "local" }];
    storeAssistants = [{ id: "l1" }];

    // WHEN retiring it
    const outcome = await retireAssistant(queryClient, "l1");

    // THEN the local retire ran and the cloud path did not
    expect(retireLocalAssistantMock).toHaveBeenCalledWith("l1");
    expect(retireAssistantByIdMock).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
  });

  test("a paired target is refused before any retire path runs", async () => {
    // GIVEN a paired target in local mode
    isLocalClientValue = true;
    lockfileAssistants = [{ assistantId: "pr1", cloud: "paired" }];
    storeAssistants = [{ id: "pr1" }];

    // WHEN retiring it
    const outcome = await retireAssistant(queryClient, "pr1");

    // THEN the guard fails fast: neither retire path ran and nothing was
    // cleaned up (the assistant still exists on its host machine).
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe(
        "This is a paired assistant. Remove it from this device instead of retiring it.",
      );
    }
    expect(retireLocalAssistantMock).not.toHaveBeenCalled();
    expect(retireAssistantByIdMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    expect(clearResearchSnapshotMock).not.toHaveBeenCalled();
  });

  test("routes by the TARGET assistant, not local-mode alone", async () => {
    // GIVEN local mode but the *target* is a cloud assistant
    isLocalClientValue = true;
    lockfileAssistants = [{ assistantId: "p1", cloud: "cadet" }];
    storeAssistants = [{ id: "p1" }];

    // WHEN retiring the cloud target
    const outcome = await retireAssistant(queryClient, "p1");

    // THEN it uses the cloud delete (not local)
    expect(retireAssistantByIdMock).toHaveBeenCalledWith("p1", {});
    expect(retireLocalAssistantMock).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
  });

  test("a 404 from the cloud delete is treated as success", async () => {
    lockfileAssistants = [{ assistantId: "p1", cloud: "cadet" }];
    storeAssistants = [{ id: "p1" }];
    retireByIdResult = { ok: false, status: 404, error: {} };

    const outcome = await retireAssistant(queryClient, "p1");

    expect(outcome.ok).toBe(true);
  });

  test("a non-404 platform failure surfaces the error detail", async () => {
    lockfileAssistants = [{ assistantId: "p1", cloud: "cadet" }];
    storeAssistants = [{ id: "p1" }];
    retireByIdResult = { ok: false, status: 500, error: { detail: "boom" } };

    const outcome = await retireAssistant(queryClient, "p1");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("boom");
    }
  });

  test("post-retire redirects to the assistant when other assistants remain", async () => {
    isLocalClientValue = true;
    lockfileAssistants = [
      { assistantId: "l1", cloud: "local" },
      { assistantId: "p1", cloud: "cadet" },
    ];
    storeAssistants = [{ id: "l1" }, { id: "p1" }];

    const outcome = await retireAssistant(queryClient, "l1");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.nextRoute).toBe("/assistant");
    }
  });

  test("post-retire redirects to welcome when no assistants and not logged in", async () => {
    isLocalClientValue = true;
    lockfileAssistants = [{ assistantId: "l1", cloud: "local" }];
    storeAssistants = [{ id: "l1" }];

    const outcome = await retireAssistant(queryClient, "l1");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.nextRoute).toBe("/assistant/welcome");
    }
  });
});
