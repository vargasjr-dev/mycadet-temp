import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

const authRef = {
  sessionStatus: "authenticated" as const,
  isSessionInitializing: false,
  hasCloudSession: true,
};
const resolvedRef = {
  assistants: [
    {
      id: "assistant-1",
      name: "Primary",
      isLocal: false,
      isCloudHosted: true,
    },
  ],
  activeAssistantId: "assistant-1" as string | null,
  selectedAssistantId: null as string | null,
  assistantsHydrated: true,
};
const orgRef = {
  currentOrganizationId: "org-1" as string | null,
};

const useAssistantLifecycleMock = mock((_options: unknown) => undefined);
mock.module("@/assistant/use-lifecycle", () => ({
  useAssistantLifecycle: useAssistantLifecycleMock,
}));

mock.module("@/hooks/use-app-theme", () => ({
  useAppTheme: () => undefined,
}));

const useConversationListQueryMock = mock(
  (_assistantId: string | null, _enabled: boolean) => ({
    conversations: [
      {
        conversationId: "conv-1",
        title: "Recent conversation",
        lastMessageAt: "2026-06-10T00:00:00.000Z",
      },
    ],
    isLoading: false,
    isPending: false,
    isError: false,
    error: null,
    refetch: () => undefined,
  }),
);
mock.module("@/hooks/conversation-queries", () => ({
  useConversationListQuery: useConversationListQueryMock,
}));

const localSelectedRef = {
  value: null as { assistantId: string; name?: string } | null,
};
mock.module("@/lib/local-mode", () => ({
  isServedGatewayRuntime: () => undefined,
  isLocalClient: () => false,
  getSelectedAssistant: () => localSelectedRef.value,
  getActiveAssistant: () =>
    resolvedRef.activeAssistantId
      ? { assistantId: resolvedRef.activeAssistantId }
      : undefined,
  setActiveLockfileAssistant: async () => undefined,
}));

mock.module("@/lib/auth/gateway-session", () => ({
  setRemoteGatewayToken: () => {},
  isGatewayAuthMode: () => false,
  // lifecycle-service (in the palette's import graph) reads the token at
  // call time; no gateway session exists under these tests.
  getGatewayToken: () => null,
}));

mock.module("@/stores/gateway-session-store", () => ({
  useGatewaySessionStore: () => null,
  useIsSessionInitializing: () => authRef.isSessionInitializing,
  // The lifecycle hook reads the seam's bits directly.
  use: {
    settled: () => !authRef.isSessionInitializing,
    live: () => authRef.sessionStatus === "authenticated",
    cloudLive: () => authRef.hasCloudSession,
  },
}));

mock.module("@/stores/organization-store", () => {
  const useOrganizationStore = () => null;
  useOrganizationStore.use = {
    currentOrganizationId: () => orgRef.currentOrganizationId,
  };
  useOrganizationStore.getState = () => ({
    currentOrganizationId: orgRef.currentOrganizationId,
  });
  return {
    useOrganizationStore,
    useRequestOrganizationId: () => orgRef.currentOrganizationId,
    // API interceptors read the org for request headers through this helper;
    // same value the mocked store hooks return.
    getActiveOrganizationIdForRequests: () => orgRef.currentOrganizationId,
  };
});

mock.module("@/stores/resolved-assistants-store", () => {
  const useResolvedAssistantsStore = () => null;
  useResolvedAssistantsStore.use = {
    assistants: () => resolvedRef.assistants,
    activeAssistantId: () => resolvedRef.activeAssistantId,
    selectedAssistantId: () => resolvedRef.selectedAssistantId,
    assistantsHydrated: () => resolvedRef.assistantsHydrated,
  };
  useResolvedAssistantsStore.getState = () => ({
    assistants: resolvedRef.assistants,
    selectedAssistantId: resolvedRef.selectedAssistantId,
    assistantsHydrated: resolvedRef.assistantsHydrated,
  });
  return {
    useResolvedAssistantsStore,
    assistantsValidForOrg: (
      assistants: { organizationId?: string | null; isLocal?: boolean }[],
      activeOrgId: string | null,
    ) =>
      assistants.filter(
        (a) =>
          a.isLocal ||
          a.organizationId == null ||
          a.organizationId === activeOrgId,
      ),
  };
});

const useCommandPaletteSectionsMock = mock((_params: unknown) => ({
  commandPalette: {
    close: () => undefined,
    query: "",
    setQuery: () => undefined,
    selectedIndex: 0,
    isSearching: false,
    handleKeyDown: () => undefined,
  },
  mergedSections: [
    {
      id: "actions",
      label: "Actions",
      items: [{ id: "action-new-conversation", title: "New Conversation" }],
    },
  ],
  handleItemSelect: () => undefined,
}));
mock.module("@/domains/chat/hooks/use-command-palette-sections", () => ({
  useCommandPaletteSections: useCommandPaletteSectionsMock,
}));

const { CommandPaletteWindowPage } =
  await import("@/components/command-palette/command-palette-window-page");

beforeEach(() => {
  authRef.sessionStatus = "authenticated";
  authRef.isSessionInitializing = false;
  authRef.hasCloudSession = true;
  resolvedRef.assistants = [
    {
      id: "assistant-1",
      name: "Primary",
      isLocal: false,
      isCloudHosted: true,
    },
  ];
  resolvedRef.activeAssistantId = "assistant-1";
  resolvedRef.selectedAssistantId = null;
  resolvedRef.assistantsHydrated = true;
  orgRef.currentOrganizationId = "org-1";
  localSelectedRef.value = null;

  useAssistantLifecycleMock.mockClear();
  useConversationListQueryMock.mockClear();
  useCommandPaletteSectionsMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("CommandPaletteWindowPage", () => {
  test("bootstraps assistant context for the standalone floating window", () => {
    render(<CommandPaletteWindowPage />);

    // The lifecycle hook reads the session seam itself now.
    expect(useAssistantLifecycleMock).toHaveBeenCalledWith();
    expect(useConversationListQueryMock).toHaveBeenCalledWith(
      "assistant-1",
      true,
    );
  });

  test("uses the selected platform assistant while lifecycle is still resolving", () => {
    resolvedRef.assistants = [
      {
        id: "assistant-1",
        name: "Primary",
        isLocal: false,
        isCloudHosted: true,
      },
      {
        id: "assistant-2",
        name: "Secondary",
        isLocal: false,
        isCloudHosted: true,
      },
    ];
    resolvedRef.activeAssistantId = null;
    resolvedRef.selectedAssistantId = "assistant-2";

    render(<CommandPaletteWindowPage />);

    expect(useConversationListQueryMock).toHaveBeenCalledWith(
      "assistant-2",
      true,
    );
    expect(useCommandPaletteSectionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantId: "assistant-2",
        assistantName: "Secondary",
      }),
    );
  });
});
