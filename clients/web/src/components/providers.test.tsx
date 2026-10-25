/**
 * The request-scoped QueryClient is keyed on the active assistant — cloud
 * data is assistant-scoped and the session resolves its organization through
 * that selection — so a response fetched for one assistant is never read as
 * the answer for another, and is not thrown away while that assistant still
 * holds.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";

import { appsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  getLifecycleDiagnosticsEvents,
  removeLifecycleDiagnostics,
} from "@/lib/diagnostics";
import { ApiError } from "@/utils/api-errors";

// The quick-add controller runs a daemon query and pulls in the settings
// domain's profile editor; neither participates in cache scoping.
mock.module("@/components/profile-quick-add-provider", () => ({
  ProfileQuickAddProvider: ({ children }: { children: ReactNode }) => children,
}));

const { AppProviders } = await import("@/components/providers");
const { useAuthStore } = await import("@/stores/auth-store");
const { useOrganizationStore } = await import("@/stores/organization-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");

const ORGANIZATION_ID = "org-abc";
const STORAGE_KEY = "cadet_active_organization_id";
const PROBE_KEY = ["org-scoped-probe"];
const ASSET_FAILURE_OPTIONS = {
  queryKey: appsGetQueryKey({
    path: { assistant_id: "assistant-123" },
    query: { conversationId: "conv-123" },
  }),
  queryFn: async () => {
    throw new ApiError(405, "No list");
  },
  retry: false as const,
};

function assetEvents() {
  return getLifecycleDiagnosticsEvents().filter((event) =>
    event.kind.startsWith("asset_query_"),
  );
}

let observedClient: QueryClient | null = null;

function Probe() {
  const queryClient = useQueryClient();
  useEffect(() => {
    observedClient = queryClient;
  });
  return null;
}

/**
 * The persisted organization selection: sessionStorage is where it survives a
 * reload, and the store mirrors it so consumers can subscribe to it.
 */
function seedPersistedOrganization(organizationId: string) {
  sessionStorage.setItem(STORAGE_KEY, organizationId);
  useOrganizationStore.setState({ persistedOrganizationId: organizationId });
}

function renderProviders() {
  render(
    <AppProviders>
      <Probe />
    </AppProviders>,
  );
}

beforeEach(() => {
  observedClient = null;
  sessionStorage.clear();
  removeLifecycleDiagnostics("asset_query_");
  useAuthStore.setState({
    sessionStatus: "authenticated",
    cloudSession: "present",
  });
  useOrganizationStore.setState({
    organizations: [],
    currentOrganizationId: null,
    persistedOrganizationId: null,
    status: "idle",
    error: null,
  });
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-123" });
});

afterEach(() => {
  cleanup();
});

describe("AppProviders cache scope", () => {
  test("preserves asset diagnostics across a session blip and the same re-auth", async () => {
    renderProviders();
    await expect(
      observedClient!.fetchQuery(ASSET_FAILURE_OPTIONS),
    ).rejects.toThrow();
    const previousEvents = assetEvents();
    const previousSession = useAuthStore.getState().cloudSession;

    act(() => {
      useAuthStore.setState({
        sessionStatus: "initializing",
        cloudSession: "unknown",
      });
    });
    expect(assetEvents()).toEqual(previousEvents);

    act(() => {
      useAuthStore.setState({
        sessionStatus: "authenticated",
        cloudSession: previousSession,
      });
    });
    // The assistant scope never moved, so the diagnostics were neither
    // cleared nor re-recorded: the failed query is deduped per scope until
    // it recovers.
    expect(assetEvents()).toEqual(previousEvents);
  });

  test("keeps the diagnostics when the session settles for another account", async () => {
    renderProviders();
    await expect(
      observedClient!.fetchQuery(ASSET_FAILURE_OPTIONS),
    ).rejects.toThrow();
    const previousEvents = assetEvents();

    act(() => {
      // A fresh platform session (cross-tab sign-in as another account) —
      // still "present", and the assistant selection never moved.
      useAuthStore.setState({ cloudSession: "unknown" });
      useAuthStore.setState({ cloudSession: "present" });
    });
    // The user is no longer the request identity — the assistant is, and it
    // did not move.
    expect(assetEvents()).toEqual(previousEvents);
  });

  test("clears the diagnostics when the active assistant changes", async () => {
    renderProviders();
    await expect(
      observedClient!.fetchQuery(ASSET_FAILURE_OPTIONS),
    ).rejects.toThrow();
    expect(
      getLifecycleDiagnosticsEvents().filter(
        (event) => event.kind === "asset_query_failed",
      ),
    ).toHaveLength(1);
    act(() => {
      useResolvedAssistantsStore.setState({
        activeAssistantId: "assistant-456",
      });
    });
    expect(assetEvents()).toHaveLength(0);
  });

  test("drops a prior assistant's cached responses when the selection moves", () => {
    renderProviders();
    act(() => {
      observedClient!.setQueryData(PROBE_KEY, "answer-for-assistant-123");
    });

    act(() => {
      useResolvedAssistantsStore.setState({
        activeAssistantId: "assistant-456",
      });
    });

    expect(observedClient!.getQueryData<string>(PROBE_KEY)).toBeUndefined();
  });

  test("keeps them while the org list confirms the session around the same assistant", () => {
    seedPersistedOrganization(ORGANIZATION_ID);
    renderProviders();
    act(() => {
      observedClient!.setQueryData(PROBE_KEY, "answer-for-org-abc");
    });

    act(() => {
      useOrganizationStore.setState({
        organizations: [],
        currentOrganizationId: ORGANIZATION_ID,
        status: "ready",
      });
    });

    expect(observedClient!.getQueryData<string>(PROBE_KEY)).toBe(
      "answer-for-org-abc",
    );
  });
});
