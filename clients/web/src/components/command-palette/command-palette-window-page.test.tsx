import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

const authRef = {
  sessionStatus: "authenticated" as const,
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

const useAssistantBootResolutionMock = mock(() => ({
  state: { kind: "active" },
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
/* The page's boot resolution (react-query) is fire-and-forget — the
   resolved-assistants store mock carries the state it renders. Stubbed
   spread-real so the render never needs a QueryClientProvider. */
const assistantQueries = await import("@/assistant/queries");
mock.module("@/assistant/queries", () => ({
  ...assistantQueries,
  useAssistantBootResolution: useAssistantBootResolutionMock,
}));

const localModeModule = await import("@/lib/local-mode");
mock.module("@/lib/local-mode", () => ({
  ...localModeModule,
  isServedGatewayRuntime: () => undefined,
  isLocalClient: () => false,
  isGatewaySessionLive: () => false,
  getActiveAssistant: () =>
    localSelectedRef.value ??
    (resolvedRef.activeAssistantId
      ? { assistantId: resolvedRef.activeAssistantId }
      : undefined),
  setActiveLockfileAssistant: async () => undefined,
}));

mock.module("@/stores/auth-store", () => {
  const useAuthStore = () => null;
  useAuthStore.use = {
    sessionStatus: () => authRef.sessionStatus,
  };
  return {
    useAuthStore,
    useHasCloudSession: () => authRef.hasCloudSession,
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
  localSelectedRef.value = null;

  useAssistantBootResolutionMock.mockClear();
  useConversationListQueryMock.mockClear();
  useCommandPaletteSectionsMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("CommandPaletteWindowPage", () => {
  test("bootstraps assistant context for the standalone floating window", () => {
    render(<CommandPaletteWindowPage />);

    // The #502 boot resolution replaced the lifecycle machine: the page
    // primes assistant context through it and renders the store's state.
    expect(useAssistantBootResolutionMock).toHaveBeenCalled();
    expect(useConversationListQueryMock).toHaveBeenCalledWith(
      "assistant-1",
      true,
    );
  });

  test("uses the selected platform assistant while boot resolution is still resolving", () => {
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
