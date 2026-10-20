/**
 * The flag must not move the rows.
 *
 * A conversation list spaces its children, so anything the flag adds between
 * the list and the row changes the pitch of every row under it. This pins the
 * shape rather than the pixels, which is the part a unit test can see: the
 * element the list lays out has to be the same element, with the same
 * classes, carrying the same single child, in both flag states, and it may
 * not pick up inline geometry at rest.
 *
 * The real `SwipeActionReveal` renders here (on a fine pointer it is a plain
 * `div` passthrough) because it is the element under test. Only `PanelItem`
 * and the menu surfaces are mocked, and to plain elements, so the tree above
 * the row is the one that ships.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { cleanup, render } from "@testing-library/react";

mock.module("@mycadet/design-library", () => ({
  PanelItem: ({
    label,
    trailingAction,
  }: {
    label: string;
    trailingAction?: ReactNode;
  }) =>
    createElement("div", { "data-slot": "panel-item" }, label, trailingAction),
  Tooltip: ({ children }: { children: ReactNode }) => children,
  ContextMenu: {
    Root: ({ children }: { children: ReactNode }) => children,
    Trigger: ({ children }: { children: ReactNode }) => children,
    Content: () => null,
    Item: () => null,
    Separator: () => null,
    Sub: ({ children }: { children: ReactNode }) => children,
    SubTrigger: ({ children }: { children: ReactNode }) => children,
    SubContent: ({ children }: { children: ReactNode }) => children,
  },
}));

mock.module("@/domains/chat/components/thread-status-indicator", () => ({
  hasThreadStatus: () => false,
  ThreadStatusIndicator: () => null,
}));

import { ConversationRow } from "@/domains/chat/components/conversation-row";
import { ConversationListProvider } from "@/domains/chat/components/conversation-list-context";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import type { Conversation } from "@/types/conversation-types";

const CONVERSATION: Conversation = {
  conversationId: "conv-xyz",
  title: "Launch review brief",
};

const originalMatchMedia = window.matchMedia;
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    matches: query === "(hover: hover)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

/** The element the conversation list lays out. */
function rowBox(): HTMLElement {
  const { container } = render(
    createElement(
      ConversationListProvider,
      { value: { onSelect: () => {}, onArchive: () => {} } },
      createElement(ConversationRow, { conversation: CONVERSATION }),
    ),
  );
  const box = container.firstElementChild;
  if (!(box instanceof HTMLElement)) {
    throw new Error("the row rendered no element");
  }
  return box;
}

afterEach(() => {
  cleanup();
});

afterAll(() => {
  mock.restore();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

describe("ConversationRow layout", () => {
  test("the list lays out the row directly, no wrapper between", () => {
    const box = rowBox();

    // One child, the row itself: an interposed wrapper would show up here as
    // an extra level before the panel item.
    expect(box.children).toHaveLength(1);
    expect(box.children[0]?.getAttribute("data-slot")).toBe("panel-item");
  });

  test("the row takes on no resting geometry from the list", () => {
    const on = rowBox();

    /* Anything here that spaced or sized the box at rest would move every
       row below it. */
    for (const property of [
      "height",
      "margin",
      "margin-top",
      "margin-bottom",
      "padding",
      "display",
      "overflow",
      "min-height",
      "max-height",
    ]) {
      expect(on.style.getPropertyValue(property)).toBe("");
    }
  });
});
