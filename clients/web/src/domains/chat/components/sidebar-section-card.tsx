/**
 * One sidebar section, drawn as a card.
 *
 * The card is the unit of the sidebar: Pinned, each custom group, each
 * channel, and the chat list are all this same shell with different contents.
 *
 * This component owns *only* the card surface. The header, row list, and
 * drag-to-reorder all come from {@link ConversationNavSection}. Anything that
 * belongs to "a sidebar section" belongs there, not here, so every section
 * reads identically in typography, geometry, and pointer behavior whether or
 * not it sits on a card.
 *
 * That layer is also what keeps the two menus distinct. A section's own
 * actions (mark all read, archive all, rename, delete, reorder) come from a
 * single `groupMenu`, which it renders into both the header's right-click
 * menu and, on touch, its long-press sheet. A conversation's actions (pin,
 * archive, move to group, inspect) stay on {@link ConversationRow}. The two
 * never share a surface: right-clicking a header offers section actions,
 * right-clicking a row offers that row's.
 *
 *
 * Purely presentational. It owns no query and no membership rule: rows and
 * indicator are handed in, which is what lets every section load from its own
 * server-filtered query (LUM-2443) without this component knowing the others
 * exist. Its menu is scoped to this section alone, so a section's bulk actions
 * and its contents always describe the same rows (LUM-3008).
 */

import type { ComponentProps } from "react";

import { Card } from "@mycadet/design-library";
import { cn } from "@mycadet/design-library/utils/cn";

import { useConversationListContext } from "@/domains/chat/components/conversation-list-context";
import { ConversationNavSection } from "@/domains/chat/components/conversation-nav-section";

export type SidebarSectionCardProps = ComponentProps<
  typeof ConversationNavSection
> & {
  /** Extra classes for the card surface, not the section inside it. */
  cardClassName?: string;
};

export function SidebarSectionCard({
  cardClassName,
  drag,
  ...section
}: SidebarSectionCardProps) {
  const { overlayCards } = useConversationListContext();

  /* The card is what drags, not the header inside it. A section is a card
     now, so grabbing one should pick up the whole object; with the handle on
     the header the drag image was a lone header strip, which reads as a
     conversation row rather than as the section being moved. The drop
     feedback moves with it for the same reason: the insertion line belongs
     on the edge being inserted against. */
  return (
    <Card.Root
      bordered={false}
      noPadding
      className={cn(
        /* The colour the rows inside sit on. A row swiped aside is an opaque
           cell sliding off the action behind it, and the swipe wrapper backs
           it with this surface; the card owns its surface, so it names it.
           Both the card's own paint and the swipe backing read
           `--sidebar-card-surface`, so a card that tints itself (the
           assistant section's) declares the tint once and its rows are
           backed with the same colour rather than the plain lift a white
           band would show through on a touch swipe. */
        "bg-[var(--sidebar-card-surface,var(--surface-lift))]",
        "[--swipe-item-surface:var(--sidebar-card-surface,var(--surface-lift))]",
        /* No padding of its own: the overlay class branch below owns the
           card's inset, and wrapping it in another layer of Card padding
           would inflate the pill past its spec. The row list picks up the
           matching horizontal inset directly (see
           `CollapsibleNavSection.Section`'s Content). */
        /* Collapsed, a section is a pill that hugs its own header: nothing
           inside it needs the full rail width. Its own `Collapsible.Item` is
           the card's only direct child and carries Radix's `data-state`, so
           `has-[>...]` reads that state directly rather than this component
           tracking open/closed itself. The child combinator is load-bearing:
           the header's menu triggers (the "..." Popover/BottomSheet, the
           right-click ContextMenu on the whole header) are deeper descendants
           that also carry `data-state=open` while their menu is up, and an
           unscoped `has-[]` would widen a collapsed pill into an empty
           full-width box just for opening its actions menu. Open, it becomes
           a full-width rounded rect to hold its row list.

           Radius is the same 18px number in both states - half the pill's
           own 36px height, which is what makes a 36px-tall box read as
           fully round in the first place - rather than switching between
           `rounded-full` and a smaller radius. Same value means nothing
           needs to transition or interpolate for it at all: it can never
           lag behind the width/height change since it never moves. */
        /* The overlay's card is squarer than the rail's pill and carries the
           inset its header and row list sit flush inside (Figma 7842-83305).
           The 12px vertical inset plus the 20px header row makes the
           collapsed pill exactly the overlay tile size (44px), so it stands
           level with the assistant pill above it. `border-0` drops the
           Card's default transparent 1px border, which would otherwise grow
           the border-box to 46px. The rail keeps that border and the radius
           that makes its header read as fully round.

           The overlay's card spans the drawer in both states: on a touch
           screen a collapsed section that hugged its header left a ragged
           column of pill widths down the drawer, and its "…" and chevron
           landed wherever the label ended rather than on a shared right
           edge. Only the rail collapses to the measured hug width. */
        overlayCards
          ? "w-full rounded-[16px] border-0 pt-3 pr-3 pb-3 pl-2"
          : "w-full rounded-[18px]",
        /* Only the bottom-most section ever takes leftover flex space (see
           `isLast` on `ConversationRowList`): flex-grow has no notion of
           "this section needs the room," so giving every section a share
           stretched a two-row group into a mostly-empty box the same size
           as a busy one beside it. Even the last one hugs its rows and only
           shrinks (`min-h-0`) under the rail's space; it fills (`flex-1`)
           only around a windowed row list, which needs a definite height.
           The marker is the list's own `data-slot`, since only the list
           knows which path it took. */
        !section.unbounded &&
          section.isLast &&
          "min-h-0 flex flex-col has-[[data-slot=conversation-list-windowed]]:flex-1",
        /* The card is the drag handle, so it says so. Every interactive thing
           inside it sets its own `cursor-pointer`, which wins wherever one is
           actually under the pointer - so the grab cursor shows on the card's
           own surface and nowhere else. */
        drag && "cursor-grab active:cursor-grabbing",
        drag?.dragging && "opacity-50",
        drag?.dropEdge === "before" &&
          "shadow-[inset_0_2px_0_0_var(--primary-base)]",
        drag?.dropEdge === "after" &&
          "shadow-[inset_0_-2px_0_0_var(--primary-base)]",
        cardClassName,
      )}
      {...drag?.headerProps}
    >
      <ConversationNavSection {...section} />
    </Card.Root>
  );
}
