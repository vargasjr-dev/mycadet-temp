/**
 * The load-more seam of `ConversationRowList`: `onEndReached` present means
 * a windowed list, and a windowed list carries a sentinel that pages more
 * in when scrolled to; absent means the list is complete and must not.
 *
 * Asserted at the DOM through the sentinel's `data-slot`, on the
 * direct-render path (rows under the virtualize threshold), where the
 * sentinel is the trigger. The virtualized path wires the same callback to
 * `VirtualList.endReached` and needs no DOM sentinel.
 *
 * The expand seam is gone: sections do not cap and do not fold. The tests
 * below pin the cap's absence — every section renders all of its rows and
 * the sidebar body does the scrolling.
 */

import { render } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";

import type * as ConversationRowModule from "@/domains/chat/components/conversation-row";
import { ConversationListProvider } from "@/domains/chat/components/conversation-list-context";
import type { Conversation } from "@/types/conversation-types";

/* Row rendering is not under test; a stub keeps this on the seam. Typed
   against the real module, and spread over it, so the stub replaces only
   the row and a module that grows an export still fails the build here. */
const actualRow = await import("@/domains/chat/components/conversation-row");
mock.module(
  "@/domains/chat/components/conversation-row",
  (): typeof ConversationRowModule => ({
    ...actualRow,
    ConversationRow: ({ conversation }) =>
      createElement("div", { "data-testid": "row" }, conversation.title),
  }),
);

const { ConversationRowList } =
  await import("@/domains/chat/components/conversation-nav-section");

const ROWS: Conversation[] = [
  { conversationId: "c1", title: "One" },
  { conversationId: "c2", title: "Two" },
];

function renderList(
  onEndReached?: () => void,
  extras?: {
    overlayCards?: boolean;
    isLast?: boolean;
    items?: Conversation[];
    unbounded?: boolean;
  },
) {
  const { container } = render(
    createElement(
      ConversationListProvider,
      {
        value: {
          onSelect: () => {},
          overlayCards: extras?.overlayCards,
        },
      },
      createElement(ConversationRowList, {
        items: extras?.items ?? ROWS,
        onEndReached,
        isLast: extras?.isLast,
        unbounded: extras?.unbounded,
      }),
    ),
  );
  return container;
}

const rowsIn = (container: HTMLElement) =>
  container.querySelectorAll('[data-testid="row"]');
const scrollerOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(".overflow-y-auto");

/** Twenty-five rows: past the old mid-height cap, short of the virtualize cut. */
const MANY_ROWS: Conversation[] = Array.from({ length: 25 }, (_, index) => ({
  conversationId: `m${index + 1}`,
  title: `Thread ${index + 1}`,
}));

afterEach(() => {
  mock.restore();
});

describe("ConversationRowList load-more seam", () => {
  test("a windowed list carries a load-more sentinel after its rows", () => {
    const container = renderList(() => {});

    expect(container.querySelectorAll('[data-testid="row"]')).toHaveLength(2);
    expect(
      container.querySelectorAll('[data-slot="load-more-sentinel"]'),
    ).toHaveLength(1);
  });

  test("a complete list carries no sentinel", () => {
    const container = renderList(undefined);

    expect(container.querySelectorAll('[data-testid="row"]')).toHaveLength(2);
    expect(
      container.querySelectorAll('[data-slot="load-more-sentinel"]'),
    ).toHaveLength(0);
  });
});

describe("ConversationRowList scroll ownership", () => {
  test("overlay cards grow with the drawer body instead of nesting a scroller", () => {
    const container = renderList(undefined, {
      overlayCards: true,
      isLast: true,
    });

    expect(container.querySelector(".overflow-y-auto")).toBeNull();
    expect(container.querySelectorAll('[data-testid="row"]')).toHaveLength(2);
  });

  /* Sections do not scroll within themselves: the rows render whole and the
     sidebar's own scrollport does the scrolling. */
  test("a rail section renders its rows without an inner scroller", () => {
    const container = renderList(undefined, { isLast: true });

    expect(container.querySelector(".overflow-y-auto")).toBeNull();
    expect(rowsIn(container)).toHaveLength(2);
  });

  test("a long section renders every row uncapped, with no expand control", () => {
    const container = renderList(undefined, { isLast: true, items: MANY_ROWS });

    expect(rowsIn(container)).toHaveLength(25);
    expect(container.querySelector(".overflow-y-auto")).toBeNull();
    expect(
      container.querySelector('[data-slot="sidebar-expand-row"]'),
    ).toBeNull();
    expect(scrollerOf(container)).toBeNull();
  });

  test("a non-last section renders all of its rows too", () => {
    const container = renderList(undefined, { items: MANY_ROWS });

    expect(rowsIn(container)).toHaveLength(25);
    expect(
      container.querySelector('[data-slot="sidebar-expand-row"]'),
    ).toBeNull();
  });
});
