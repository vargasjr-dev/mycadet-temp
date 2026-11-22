import { afterEach, describe, expect, test } from "bun:test";

import { useSidebarLayoutStore } from "@/domains/chat/sidebar-layout-store";

function resetStore() {
  useSidebarLayoutStore.setState({ assistantId: null, sectionOrder: [] });
}

afterEach(() => {
  resetStore();
  localStorage.clear();
});

describe("SidebarLayoutStore", () => {
  test("setAssistantId no-ops when assistantId is unchanged", () => {
    useSidebarLayoutStore.getState().setAssistantId("asst-1");
    useSidebarLayoutStore
      .getState()
      .setSectionOrder(["pinned", "recents", "channel:slack"]);

    // A second set with the same id must not wipe the in-memory state.
    useSidebarLayoutStore.getState().setAssistantId("asst-1");

    expect(useSidebarLayoutStore.getState().sectionOrder).toEqual([
      "pinned",
      "recents",
      "channel:slack",
    ]);
  });

  test("switching assistant re-hydrates section order from storage", () => {
    useSidebarLayoutStore.getState().setAssistantId("asst-1");
    useSidebarLayoutStore.getState().setSectionOrder(["recents", "pinned"]);

    // A different assistant's own stored preference, unrelated to asst-1's.
    localStorage.setItem(
      "cadet:sidebar-section-order:asst-2",
      JSON.stringify(["pinned", "recents"]),
    );
    useSidebarLayoutStore.getState().setAssistantId("asst-2");
    expect(useSidebarLayoutStore.getState().sectionOrder).toEqual([
      "pinned",
      "recents",
    ]);
  });

  test("falls back to defaults when localStorage has invalid data", () => {
    localStorage.setItem("cadet:sidebar-section-order:asst-1", "not-json");

    useSidebarLayoutStore.getState().setAssistantId("asst-1");

    expect(useSidebarLayoutStore.getState().sectionOrder).toEqual([]);
  });
});

// The view mode is deliberately not held in this store: it reads from
// storage directly so it survives the first paint. See
// sidebar-view-mode.test.ts.
