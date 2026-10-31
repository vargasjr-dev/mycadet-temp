/**
 * The request-scoped QueryClient is keyed on the active assistant — cloud
 * data is assistant-scoped — so a response fetched for one assistant is
 * never read as the answer for another, and is not thrown away while that
 * assistant still holds.
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
const { useResolvedAssistantStore } =
  await import("@/stores/resolved-assistant-store");

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
  useResolvedAssistantStore.setState({ assistant: { cloud: "local", assistantId: "assistant-123" } });
});

afterEach(() => {
  cleanup();
});

describe("AppProviders cache scope", () => {
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
      useResolvedAssistantStore.setState({
      assistant: { cloud: "local", assistantId: "assistant-456" },
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
      useResolvedAssistantStore.setState({
      assistant: { cloud: "local", assistantId: "assistant-456" },
    });
    });

    expect(observedClient!.getQueryData<string>(PROBE_KEY)).toBeUndefined();
  });
});
