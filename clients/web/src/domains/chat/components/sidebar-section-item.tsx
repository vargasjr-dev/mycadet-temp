/**
 * One sidebar conversation section, whatever its type.
 *
 * This is the single render path for Pinned, Chats, every origin-channel
 * section, and every custom group - which is what keeps their spacing and
 * header treatment identical and lets the user interleave them freely
 * (LUM-2909).
 *
 * Nothing about the *shell* varies by type. Every section gets the same card,
 * the same header, the same hover "…", and the same drag wiring, all resolved
 * before they reach here. What varies is only what goes *in* the menu, and that
 * is `sectionMenu`'s answer in `assistant-side-menu.tsx`, not this component's:
 * a custom group adds rename/delete/copy-id, Chats and the channel sections add
 * the channel-grouping toggle.
 *
 * The row list is the one real exception: every section caps and scrolls
 * within itself, except Pinned (grows to fit its own rows instead, see
 * `unbounded` on `ConversationRowList`) and the bottom-most section (may
 * take whatever space the sidebar has left instead of a fixed cap, see
 * `isLast`). Chats and the channel sections, the two that accumulate
 * without bound, rest at a mid height when they are that bottom-most
 * section and grow to the full height on request (see `expandable`); the
 * choice is kept per section in the sidebar layout store so it survives a
 * reload like the section's open state does.
 */

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";

import { useTranslation } from "@/i18n";

import type { CollapsibleNavSectionDrag } from "@/components/collapsible-nav-section";
import { SidebarSectionEmptyState } from "@/domains/chat/components/sidebar-section-empty-state";
import { SidebarSectionCard } from "@/domains/chat/components/sidebar-section-card";
import {
  GroupActionsMenu,
  type GroupMenuItemsProps,
} from "@/domains/chat/components/group-actions-menu";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import { useSectionConversations } from "@/domains/chat/use-section-conversations";
import { sectionIcon } from "@/domains/chat/utils/sidebar-section-icon";
import type { Conversation } from "@/types/conversation-types";

export interface SidebarSectionItemProps {
  section: SidebarSection;
  /** Owns this section's query; `null` keeps it on the derived rows. */
  /**
   * Header actions, given the section's own rows. A function rather than a
   * built menu because the rows are resolved here: the sidebar decides what
   * the bulk actions *are*, this decides what they act on. `getAllRows` is
   * how the bulk actions cover every member when the rendered rows are a
   * window (LUM-2444): it drains the section at click time, so "mark all
   * read" reaches rows the user never scrolled to.
   */
  groupMenu: (
    conversations: Conversation[],
    getAllRows: () => Promise<Conversation[]>,
  ) => GroupMenuItemsProps;
  /** Section drag-reorder wiring; omit to pin the section in place. */
  drag?: CollapsibleNavSectionDrag;
  /**
   * Whether this is the bottom-most section in the list. Only it claims the
   * sidebar's leftover space when open; every section above it always sizes
   * to its own content (capped and scrolling internally past a point), since
   * flex-grow has no notion of "this one actually needs the room" - handing
   * every open section a share stretched a two-row group into a mostly-empty
   * box the same size as a busy one beside it.
   */
  isLast?: boolean;
}

export function SidebarSectionItem({
  section,
  groupMenu: buildGroupMenu,
  drag,
  isLast,
}: SidebarSectionItemProps) {
  const assistantId = useActiveAssistantId();
  const { t } = useTranslation("chat");
  const { conversations, hasMore, resolved, loadMore, getAllRows } =
    useSectionConversations(assistantId, section);

  /* Every section handed to this component renders. Whether a section exists
     at all is `use-sidebar-state`'s answer, and it has to stay the only one:
     the move-up/move-down nudges count entries in that list, so a section that
     is present but returns `null` here offers a move that swaps with something
     off screen.

     One predicate for membership and visibility, or the two drift and this
     recurs at the next section type. */
  const groupMenu = {
    ...buildGroupMenu(conversations, getAllRows),
  };
  return (
    <SidebarSectionCard
      icon={sectionIcon(section)}
      label={section.label}
      /* The name in the emphasised ink rather than the shared header
         classes' tertiary gray: this header sits on its own tinted surface,
         where the section-family gray reads as disabled instead of quiet.
         Set on the label span, so it overrides by inheritance rather than
         specificity. */
      /* The "…" button and the header's right-click menu both render from
         `groupMenu`. Every section carries it: a section's actions should not
         depend on which kind it is, and Chats and the channels have their own
         (the channel-grouping toggle) on top of the bulk ones. */
      trailing={<GroupActionsMenu label={section.label} {...groupMenu} />}
      groupMenu={groupMenu}
      drag={drag}
      // Sections do not fold and do not cap: every section renders all of
      // its rows. Pinned stays the one section that never caps/scrolls
      // internally — it grows to fit its own rows.
      unbounded={section.type === "pinned"}
      isLast={isLast}
      items={conversations}
      onEndReached={hasMore ? loadMore : undefined}
      /* The two sections that render at zero, so the two with anything to
         say there. Chats says it only once its own read has answered: before
         that, an empty stand-in is not an empty section. `ConversationNavSection` resolves this as
         `children ?? <ConversationRowList/>`, so it has to be exactly
         `undefined` in every other case or a section would lose its rows to
         an empty node. Passed as a prop rather than as a JSX child for that
         reason: it keeps the absent case unambiguous. */
      children={
        conversations.length > 0 ? undefined : section.type === "recents" &&
          resolved ? (
          <SidebarSectionEmptyState
            title={t("chatsSection.emptyTitle")}
            body={t("chatsSection.emptyBody")}
          />
        ) : undefined
      }
    />
  );
}
