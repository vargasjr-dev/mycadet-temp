/**
 * `SidebarSectionItem`'s row-list resolution: `ConversationNavSection`
 * resolves its body as `children ?? <ConversationRowList/>`, so a `children`
 * that is anything other than `undefined` for a section would silently
 * replace its rows with nothing. The assertions below pin both directions of
 * that.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import type * as SectionConversations from "@/domains/chat/use-section-conversations";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import type { Conversation } from "@/types/conversation-types";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

/** What the section query answers with, per test. */
let sectionRows: Conversation[] = [];
/** Whether that answer is the section's real membership, per test. */
let sectionResolved = true;

mock.module(
  "@/domains/chat/use-section-conversations",
  (): Partial<typeof SectionConversations> => ({
    useSectionConversations: () => ({
      conversations: sectionRows,
      hasMore: false,
      loadMore: () => {},
      getAllRows: () => Promise.resolve(sectionRows),
      resolved: sectionResolved,
    }),
  }),
);

const { SidebarSectionItem } =
  await import("@/domains/chat/components/sidebar-section-item");
const { ConversationListProvider } =
  await import("@/domains/chat/components/conversation-list-context");
const { CollapsibleNavSection } =
  await import("@/components/collapsible-nav-section");

function conv(conversationId: string, title: string): Conversation {
  return {
    conversationId,
    title,
    hasUnseenLatestAssistantMessage: false,
  };
}

function chatsSection(): SidebarSection {
  return {
    type: "recents",
    key: "recents",
    label: "Chats",
    all: [],
    holdsChannels: true,
  };
}

function renderSection(section: SidebarSection, overlayCards = false) {
  /* The empty state's eyes read the avatar through a query, so the tree needs
     a client even though nothing here asserts on the avatar. */
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  /* The header's "View all chats" is a route link, so the section needs the
     router it always has in the app. */
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ConversationListProvider
          value={{
            overlayCards,
            processingConversationIds: new Set<string>(),
            attentionConversationIds: new Set<string>(),
            onSelect: () => {},
          }}
        >
          <CollapsibleNavSection.Root
            type="multiple"
            defaultValue={[section.key]}
          >
            <SidebarSectionItem
              section={section}
              assistantId="asst-1"
              groupMenu={() => ({})}
            />
          </CollapsibleNavSection.Root>
        </ConversationListProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  sectionRows = [];
  sectionResolved = true;
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("SidebarSectionItem — every other section", () => {
  test("keeps its rows, so the empty-state branch cannot blank them", () => {
    // The regression this guards: `children` is resolved with `??`, so a
    // non-undefined value here would replace the row list for every section.
    sectionRows = [conv("c1", "Lease renewal")];
    renderSection(chatsSection());

    expect(screen.getAllByText("Lease renewal").length).toBeGreaterThan(0);
  });

  test("gets no assistant empty state or header when it is empty", () => {
    renderSection(chatsSection());

    expect(screen.queryByText("Nothing on my mind yet.")).toBeNull();
    expect(screen.getByText("Chats")).toBeTruthy();
  });
});

describe("SidebarSectionItem — an empty Chats section", () => {
  test("says so once its own read has answered", () => {
    renderSection(chatsSection());

    expect(screen.getByText("No chats yet.")).toBeTruthy();
  });

  /* Before the section's read answers, its rows are a stand-in derived from
     the foreground page, which can be empty while older chats exist. */
  test("says nothing while its read has not answered", () => {
    sectionResolved = false;
    renderSection(chatsSection());

    expect(screen.queryByText("No chats yet.")).toBeNull();
    expect(screen.queryByText("All caught up.")).toBeNull();
  });
});
