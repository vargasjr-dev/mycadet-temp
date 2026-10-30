import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useRef } from "react";
import {
  createMemoryRouter,
  Outlet,
  RouterProvider,
  useLocation,
  useNavigate,
} from "react-router";

import { useSyncExternalStore } from "react";

import type { AssistantResolutionState } from "@/assistant/types";
import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";

let resolutionState: AssistantResolutionState = { kind: "loading" };
const resolutionListeners = new Set<() => void>();
function setResolutionState(next: AssistantResolutionState) {
  resolutionState = next;
  for (const listener of resolutionListeners) {
    listener();
  }
}


/**
 * The hosting answer lives on the lockfile entry's remote field, not the
 * resolution kind. A local stamp synthesizes a self-hosted entry for the
 * active id; the cloud world (no assistantId) synthesizes none, so the
 * active row reads cloud-hosted.
 */
function setHosting(kind: "local" | "cloud") {
  if (kind === "local") {
    window.__CADET_CONFIG__ = { remote: "local", assistantId: "asst-local" };
    useResolvedAssistantsStore.setState({ activeAssistantId: "asst-local" });
  } else {
    useResolvedAssistantsStore.setState({ activeAssistantId: "asst-platform" });
  }
}

mock.module("@/assistant/queries", () => ({
  useAssistantResolution: () =>
    ({
      state: useSyncExternalStore(
        (cb) => {
          resolutionListeners.add(cb);
          return () => resolutionListeners.delete(cb);
        },
        () => resolutionState,
      ),
    }) as { state: AssistantResolutionState },
  useAssistantBootResolution: () => ({ state: resolutionState }),
}));

import type * as ConversationQueries from "@/hooks/conversation-queries";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import type * as ActiveChat from "../active-chat-view";
import { ChatLayoutHeader } from "../chat-layout-header";
import { DocumentChatContent } from "../components/document-chat-content";
import type { DocumentViewerContainerHandle } from "../components/document-viewer-container";
import type * as Setup from "../components/setup-screen";
import type * as Cleanup from "../components/cleanup-screen";
import {
  getDocumentConversationRoute,
  returnFromDocument,
} from "../document-conversation-navigation";
import { useDocumentHeaderVisible } from "./use-document-header-visible";

let conversationListError = false;
let firstMessageSetup = false;
let documentPhase: "loading" | "error" | "missing" = "loading";
const toggleSidebar = mock(() => {});

mock.module(
  "@/hooks/conversation-queries",
  (): Partial<typeof ConversationQueries> => ({
    useConversationListQuery: () => ({
      conversations: [],
      isLoading: false,
      isPending: false,
      isError: conversationListError,
      error: null,
      hasData: !conversationListError,
      hasMore: false,
      refetch: () => {},
    }),
  }),
);
mock.module(
  "../components/setup-screen",
  (): Partial<typeof Setup> => ({ SetupScreen: () => <div>Setting up</div> }),
);
mock.module(
  "../components/cleanup-screen",
  (): Partial<typeof Cleanup> => ({
    CleanupScreen: () => <div>Cleaning up</div>,
  }),
);
mock.module(
  "../active-chat-view",
  (): Partial<typeof ActiveChat> => ({
    ActiveChatView: () => {
      const editorRef = useRef<DocumentViewerContainerHandle>(null);
      const location = useLocation();
      const navigate = useNavigate();
      const route = getDocumentConversationRoute(location.search);
      if (firstMessageSetup) {
        return <div>Starting first message</div>;
      }
      return (
        <DocumentChatContent
          assistantId="assistant-1"
          surfaceId={route.surfaceId}
          document={null}
          loading={documentPhase === "loading"}
          error={documentPhase === "error" ? "Document unavailable" : null}
          editorRef={editorRef}
          onRetry={() => {}}
          onSubmitFeedback={() => {}}
          onClose={() =>
            returnFromDocument(
              navigate,
              route.surfaceId ?? "",
              route.returnTo,
              location.state,
            )
          }
        />
      );
    },
  }),
);

const { ChatPage } = await import("../chat-page");
const viewport = viewportAxesStub();
const initialSelection = useResolvedAssistantsStore.getState();
const initialSlots = useChatLayoutSlotsStore.getState();
let queryClient: QueryClient;

function Layout() {
  const documentHeaderVisible = useDocumentHeaderVisible();
  const isMobile = useIsMobile();
  return (
    <>
      {!documentHeaderVisible && (
        <ChatLayoutHeader
          isMobile={isMobile}
          drawerOpen={false}
          collapsed={false}
          toggleSidebar={toggleSidebar}
        />
      )}
      <Outlet />
    </>
  );
}

function renderPage(
  url = "/assistant/conversations/conv-1?document=surface-1",
) {
  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [
          {
            path: "/assistant/conversations/:conversationId",
            element: <ChatPage />,
          },
          { path: "/assistant/library", element: <div>Library</div> },
        ],
      },
    ],
    { initialEntries: [url] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  viewport.set({ narrow: true, coarsePointer: true });
  setResolutionState({ kind: "active" });
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  useChatLayoutSlotsStore.setState({ documentHeader: null });
  conversationListError = false;
  firstMessageSetup = false;
  documentPhase = "loading";
  toggleSidebar.mockClear();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  viewport.restore();
  setResolutionState({ kind: "loading" });
  useResolvedAssistantsStore.setState(initialSelection, true);
  useChatLayoutSlotsStore.setState(initialSlots, true);
});

describe("document navigation header handoff", () => {
  const states: AssistantResolutionState[] = [
    { kind: "loading" },
    { kind: "error", message: "Assistant unavailable" },
    { kind: "initializing" },
    { kind: "cleaning_up" },
  ];
  test.each(states)(
    "keeps navigation for a cold document link in $kind",
    (assistantState) => {
      setResolutionState(assistantState);
      const router = renderPage();
      fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
      expect(toggleSidebar).toHaveBeenCalledTimes(1);
      expect(
        Boolean(screen.queryByRole("button", { name: "Close document" })),
      ).toBe(false);
      router.dispose();
    },
  );

  // Session auth is the app shell's concern; web no longer renders an auth
  // phase, so only web-owned pre-mount guards remain.
  test.each(["self-hosted-error", "first-message"])(
    "keeps navigation before the document host mounts during %s",
    (guard) => {
      if (guard.startsWith("self-hosted")) {
        setResolutionState({ kind: "active" });
        setHosting("local");
      }
      if (guard === "self-hosted-error") {
        conversationListError = true;
      }
      if (guard === "first-message") {
        firstMessageSetup = true;
      }
      const router = renderPage();
      expect(
        screen.getByRole("button", { name: "Open navigation" }),
      ).toBeTruthy();
      expect(useChatLayoutSlotsStore.getState().documentHeader).toBeNull();
      router.dispose();
    },
  );

  test.each(["loading", "error"] as const)(
    "hands navigation to a mounted %s document and restores it on failure",
    async (phase) => {
      documentPhase = phase;
      const router = renderPage();
      expect(
        screen.getByRole("button", { name: "Close document" }),
      ).toBeTruthy();
      expect(
        Boolean(screen.queryByRole("button", { name: "Open navigation" })),
      ).toBe(false);
      act(() => {
        setResolutionState({ kind: "error", message: "Disconnected" });
      });
      expect(
        screen.getByRole("button", { name: "Open navigation" }),
      ).toBeTruthy();
      act(() => {
        setResolutionState({ kind: "active" });
      });
      expect(
        Boolean(screen.queryByRole("button", { name: "Open navigation" })),
      ).toBe(false);
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Close document" })),
      );
      expect(router.state.location.pathname).toBe("/assistant/library");
      expect(
        screen.getByRole("button", { name: "Open navigation" }),
      ).toBeTruthy();
      router.dispose();
    },
  );

  test("keeps navigation when the document host has no close action", () => {
    documentPhase = "missing";
    const router = renderPage();
    expect(
      screen.getByRole("button", { name: "Open navigation" }),
    ).toBeTruthy();
    expect(useChatLayoutSlotsStore.getState().documentHeader).toBeNull();
    router.dispose();
  });

  test("an older header cleanup cannot clear a newer host for the same document", () => {
    const register = useChatLayoutSlotsStore.getState().registerDocumentHeader;
    const releaseOld = register("surface-1");
    const releaseNew = register("surface-1");
    const latest = useChatLayoutSlotsStore.getState().documentHeader;
    releaseOld();
    expect(useChatLayoutSlotsStore.getState().documentHeader).toBe(latest);
    releaseNew();
    expect(useChatLayoutSlotsStore.getState().documentHeader).toBeNull();
  });

  test.each(["desktop", "transcript", "library"])(
    "keeps the layout header for %s presentation",
    (presentation) => {
      if (presentation === "desktop") {
        viewport.set({ narrow: false, coarsePointer: false });
      }
      const router = renderPage(
        presentation === "library"
          ? "/assistant/library?document=surface-1"
          : `/assistant/conversations/conv-1?document=surface-1${presentation === "transcript" ? "&documentView=chat" : ""}`,
      );
      expect(
        Boolean(document.querySelector('[data-slot="chat-layout-header"]')),
      ).toBe(true);
      router.dispose();
    },
  );
});
