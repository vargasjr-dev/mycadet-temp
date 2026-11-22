/**
 * The two list-shaped pieces of the sidebar conversation list:
 *
 * - {@link ConversationRowList} - the one way conversation rows render as a
 *   list, used by every section and by the All view's flat list.
 * - {@link ConversationNavSection} — a `CollapsibleNavSection.Section`
 *   shell (icon + label + trailing + context menu) wrapping a
 *   `ConversationRowList`. Used by channel sections and custom groups.
 *
 * A windowed section paginates: `onEndReached` fires at the bottom of the
 * rows and pages more in (LUM-2444). What differs per section is where the
 * rows scroll. On the rail, only the bottom-most section (`isLast`) may
 * take whatever space the sidebar has left above the pinned footer: it hugs
 * its rows until they outgrow that space, then scrolls within itself. It
 * hugs rather than fills because a short list stretched into a card the
 * height of the rail is mostly empty surface. The one exception is a
 * windowed list, which fills: a virtualized list needs a definite height to
 * know what to render, and a list long enough to window has outgrown the
 * rail anyway.
 *
 * Sections do not cap and do not fold: every section renders all of its
 * rows and the sidebar's own scrollport does the scrolling, so the number of
 * visible conversations is the rail's to give, not a section's to ration.
 * A windowed list is the one exception — it fills the rail's leftover height
 * because a virtualized list needs a definite height to know what to render.
 *
 * The overlay drawer and the flat list scroll against the sidebar body
 * (`scrollParent` / `overlayCards`), which keeps those surfaces to a single
 * scrollbar so nested lists cannot trap rows behind the floating action
 * pills; neither has a height of its own to expand, so the control is the
 * rail's alone.
 *
 * Either way a list past {@link CONVERSATION_LIST_VIRTUALIZE_THRESHOLD} rows
 * windows rather than mounting every one, because an assistant accumulates
 * conversations indefinitely. Shorter lists mount directly and skip
 * virtuoso's measuring pass.
 *
 * Row callbacks and state come from {@link useConversationListContext}
 * (via `ConversationRow`), so neither takes them as props.
 */

import { type ReactNode } from "react";

import { type LucideIcon } from "lucide-react";

import { ContextMenu, SideMenu } from "@mycadet/design-library";
import { VirtualList } from "@mycadet/design-library/components/virtual-list";

import {
  CollapsibleNavSection,
  type CollapsibleNavSectionDrag,
} from "@/components/collapsible-nav-section";
import { SIDEBAR_SECTION_MAX_HEIGHT } from "@/components/sidebar-nav-geometry";
import { useConversationListContext } from "@/domains/chat/components/conversation-list-context";
import { ConversationRow } from "@/domains/chat/components/conversation-row";
import { LoadMoreSentinel } from "@/domains/chat/components/load-more-sentinel";
import {
  hasAnyGroupMenuAction,
  renderGroupMenuItems,
  renderGroupMenuItemsAsPanelItems,
  type GroupMenuItemsProps,
} from "@/domains/chat/components/group-actions-menu";
import { useConversationDoneLabels } from "@/utils/done-labels";
import { useTranslation } from "@/i18n";
import type { Conversation } from "@/types/conversation-types";

/**
 * Row count past which a conversation list windows its rows instead of
 * mounting all of them. Below it the rows mount directly, which is the common
 * case and skips virtuoso's measuring pass.
 */
export const CONVERSATION_LIST_VIRTUALIZE_THRESHOLD = 30;

/**
 * Marks the windowed list's box so the section chain above it
 * (`SidebarSectionCard`, `CollapsibleNavSection.Section`) can switch the
 * last section from hugging its rows to filling the rail: a virtualized
 * list needs a definite height, and only the list knows which path it took.
 */
export const CONVERSATION_LIST_WINDOWED_SLOT = "conversation-list-windowed";

export interface ConversationRowListProps {
  items: Conversation[];
  /**
   * Scroll against this ancestor rather than bounding the list. Only the flat
   * list passes it: it already fills the sidebar body, so opening a scroller
   * of its own would put a second scrollbar in the rail.
   */
  scrollParent?: HTMLElement;
  /**
   * Skips the sizing below entirely: the list grows to fit every row
   * instead. Pinned is the one section that wants this, the user's own
   * curation, expected to stay short - and (unlike Chats or a channel
   * section) not something that should ever push its neighbours off screen.
   */
  unbounded?: boolean;
  /**
   * Whether this is the bottom-most section in the list. It grows to fill
   * whatever space the sidebar has left, then scrolls within itself past
   * that. Every other section caps at {@link SIDEBAR_SECTION_MAX_HEIGHT}
   * instead and scrolls sooner, so it can't stretch past its own content
   * just because the flex column had room to give it.
   */
  isLast?: boolean;
  /**
   * Fires when the user scrolls to the bottom of the rows - the load-more
   * trigger for a windowed list (LUM-2444). Pass only while more rows
   * exist; the virtualized path wires it to `VirtualList.endReached` and
   * the direct path renders a {@link LoadMoreSentinel} after the rows.
   */
  onEndReached?: () => void;
}

export function ConversationRowList({
  items,
  scrollParent,
  unbounded,
  isLast,
  onEndReached,
}: ConversationRowListProps) {
  const { overlayCards, scrollParent: contextScrollParent } =
    useConversationListContext();
  const listScrollParent = scrollParent ?? contextScrollParent;
  /* Overlay cards and any list given an ancestor scroller grow with that
     ancestor. A nested `overflow-y-auto` on the overlay would trap its
     last rows behind the floating pills: the inner list cannot move those
     rows into the body's reserved padding. */
  const scrollWithBody = overlayCards === true || listScrollParent != null;

  const windows =
    !unbounded && items.length > CONVERSATION_LIST_VIRTUALIZE_THRESHOLD;

  const renderRow = (conversation: Conversation) => (
    <ConversationRow
      key={conversation.conversationId}
      conversation={conversation}
      windowed={windows}
    />
  );

  const rows = (
    <SideMenu.SubList>
      {items.map(renderRow)}
      {onEndReached ? <LoadMoreSentinel onVisible={onEndReached} /> : null}
    </SideMenu.SubList>
  );

  if (!windows) {
    // No per-section cap and no Expand/Collapse footer: every section renders
    // all of its rows and the sidebar's own scrollport does the scrolling.
    // The number of visible conversations is the rail's to give, not the
    // section's to ration.
    return rows;
  }

  /* The primitive paints `--surface-base` for a list that owns its surface;
     every list here sits on a sidebar that has already painted its own. */
  const windowed = (
    <VirtualList
      items={items}
      customScrollParent={listScrollParent}
      computeItemKey={(_, conversation) => conversation.conversationId}
      itemContent={(_, conversation) => renderRow(conversation)}
      endReached={onEndReached}
      className={
        listScrollParent || scrollWithBody
          ? "bg-transparent"
          : "h-full bg-transparent"
      }
    />
  );

  if (scrollWithBody) {
    /* The overlay body's ref lands one commit after first paint. Until it
       does, mount the rows directly so a windowed list is not an empty
       virtuoso viewport with no scroll parent. */
    return listScrollParent ? windowed : rows;
  }

  /* Scrolling against an ancestor means no height of our own. Otherwise
     virtuoso's scroller sizes to 100%: the last section fills whatever
     height its own flex-fill sizing (see `CollapsibleNavSection.Section`)
     gives it, every other section gets a fixed height so a busy non-last
     section still can't push its neighbours off screen. A last section at
     its mid height takes the fixed height too: it is not filling anything.

     The last section's fill only resolves while every ancestor between the
     sidebar body and this box forwards the body's height (flex column with
     flex-1/min-h-0 at each layer). A windowed list renders only what fits
     its viewport, so unlike the mounted-rows path a broken chain here does
     not degrade to a tall list, it degrades to an empty one. The min-height
     floor caps that failure at "a section-sized scrollable box": rows stay
     reachable even if a layout change above drops the chain. */
  return (
    <div
      data-slot={CONVERSATION_LIST_WINDOWED_SLOT}
      className={isLast ? "h-full min-h-0 flex-1" : undefined}
      style={isLast ? { minHeight: SIDEBAR_SECTION_MAX_HEIGHT } : undefined}
    >
      {windowed}
    </div>
  );
}

export interface ConversationNavSectionProps extends ConversationRowListProps {
  label: string;
  icon?: LucideIcon;
  /** Leading glyph for a section whose mark is not a Lucide icon. */
  iconNode?: ReactNode;
  /** Forwarded to `CollapsibleNavSection.Section`: extra label-span classes. */
  labelClassName?: string;
  /** Forwarded to `CollapsibleNavSection.Section`: extra header-row classes. */
  headerClassName?: string;
  trailing?: ReactNode;
  /**
   * Bulk/group actions for this section's header. Rendered as a right-click
   * context menu on desktop and a long-press bottom sheet on touch — both
   * from this one prop, so the two surfaces can't drift. Omit (or pass a
   * props object with no callbacks) for a section with no header actions.
   */
  groupMenu?: GroupMenuItemsProps;
  /** Section-level drag-to-reorder wiring; omit to pin the section in place. */
  drag?: CollapsibleNavSectionDrag;
  /**
   * Overrides the default `ConversationRowList` content, e.g. nested
   * sub-sections instead of a row list. `items`/pagination/drag props are
   * still required by the type but go unused when this is provided.
   */
  children?: ReactNode;
}

export function ConversationNavSection({
  label,
  icon,
  iconNode,
  labelClassName,
  headerClassName,
  trailing,
  groupMenu,
  drag,
  children,
  ...listProps
}: ConversationNavSectionProps) {
  const hasMenu = groupMenu != null && hasAnyGroupMenuAction(groupMenu);
  const { overlayCards } = useConversationListContext();
  const { t } = useTranslation("chat");
  const doneLabels = useConversationDoneLabels();

  return (
    <CollapsibleNavSection.Section
      card={overlayCards}
      icon={icon}
      iconNode={iconNode}
      label={label}
      labelClassName={labelClassName}
      headerClassName={headerClassName}
      trailing={trailing}
      contextMenuContent={
        hasMenu
          ? renderGroupMenuItems({
              Primitive: ContextMenu,
              ...groupMenu,
              t,
              doneLabels,
            })
          : undefined
      }
      touchMenuContent={
        hasMenu
          ? (close) =>
              renderGroupMenuItemsAsPanelItems({
                ...groupMenu,
                onClose: close,
                t,
                doneLabels,
              })
          : undefined
      }
      drag={drag}
      unbounded={listProps.unbounded}
      isLast={listProps.isLast}
    >
      {children ?? <ConversationRowList {...listProps} />}
    </CollapsibleNavSection.Section>
  );
}
