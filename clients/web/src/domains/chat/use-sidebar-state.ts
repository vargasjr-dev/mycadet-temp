/**
 * Which sections the sidebar has, and in what order.
 *
 * Owns the section *list* and the user's section order. It does not own a section's contents: Pinned
 * and each custom group fetch their own rows where they render, through
 * {@link useSectionConversations}. What this hook still puts on
 * {@link SidebarSection.all} is the list derived from the foreground page,
 * which those sections use only as the fallback they paint while their own
 * query is pending or gated off.
 *
 * That split is the point of LUM-2443. Deriving a section by filtering one
 * shared list makes a *complete* list a precondition for the sidebar being
 * right, which is why a windowed conversation list kept getting reverted.
 * Discovery is what stays here, and it never needed the conversation list:
 * Pinned and Chats are fixed, and the custom groups come from the groups API.
 *
 * Which sections exist is still decided here, from the loaded list. That is
 * the last client-side derivation of conversation data in the sidebar, and it
 * survives only because the foreground list still drains in full. See the
 * comment on `defaultSections` for why it cannot simply move down with the
 * contents, and for the point at which it has to go.
 *
 * Two views share all of that, and they differ only in how many sections come
 * out. In `all` (the default) they are Pinned, the custom groups, and Chats,
 * which holds every conversation the others did not claim. In `grouped`, one
 * section per origin channel joins them and Chats keeps the remainder. Neither
 * view has a list outside the sections.
 *
 * The headline output is {@link SidebarState.sections}: one flat, ordered
 * list of every renderable section (Pinned, Chats, each channel, each custom
 * group) as a discriminated union. The sidebar walks that list in order and
 * does not know which section types exist or where they "belong", which is
 * what lets the user put any section anywhere. There is no tier: a section's
 * kind decides what it contains, never where it can sit.
 *
 * Memoizes grouping per `conversations` reference so parent re-renders
 * that don't change the conversation list skip the grouping work.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 * @see {@link https://react.dev/reference/react/useMemo}
 */

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useCallback, useEffect, useMemo, startTransition } from "react";

import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import {
  groupConversations,
  type CustomGroup,
} from "@/domains/chat/utils/group-conversations";
import { useSidebarLayoutStore } from "@/domains/chat/sidebar-layout-store";
import { channelSectionKey } from "@/domains/chat/utils/sidebar-group-collapse-storage";
import {
  mergeSectionOrder,
  moveSectionKey,
  nextStoredOrder,
} from "@/domains/chat/utils/sidebar-section-order";
import {
  saveViewMode,
  useViewMode,
  type SidebarViewMode,
} from "@/domains/chat/utils/sidebar-view-mode";
import { useSidebarSectionsQuery } from "@/hooks/conversation-queries";
import { getChannelLabel } from "@/utils/channel-presentation";
import { RECENTS_SECTION_LABEL } from "@/domains/chat/utils/sidebar-section-icon";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Shared empty array for the "no attention anywhere" case - the common one.
 * Returning a fresh `[]` would give every dependent memo a new identity on
 * each render.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface SidebarSectionBase {
  /**
   * Collapse key *and* section-order key - one namespace, so the two can
   * never disagree about what a section is called.
   */
  key: string;
  /** Header label. */
  label: string;
  /** Every conversation in the section. */
  all: Conversation[];
  /**
   * Unread members per the daemon's section index, when the index is
   * driving discovery. `undefined` on the derived path, where the unread
   * bit is scanned from the rows instead. The collapsed indicator prefers
   * this over the scan: the index counts the whole section, while the rows
   * here are only what the client has loaded.
   */
  unread?: number;
}

/**
 * One renderable sidebar section. Discriminated by `type` so the sidebar can
 * render a heterogeneous, user-ordered list without re-deriving which bucket
 * each section came from.
 */
export type SidebarSection =
  | (SidebarSectionBase & { type: "pinned" })
  /* `holdsChannels` is what the view switch means for this section: with
     channel grouping off there are no channel sections, so Chats holds those
     conversations too. Carried on the section rather than read from the view
     mode where the query is built, so the section states its own contents and
     its fetch cannot disagree with its derived fallback. */
  | (SidebarSectionBase & { type: "recents"; holdsChannels: boolean })
  | (SidebarSectionBase & { type: "channel"; channelId: string })
  | (SidebarSectionBase & { type: "group"; group: CustomGroup });

export interface SidebarState {
  /** Which view the sidebar renders. */
  viewMode: SidebarViewMode;
  /** Switch views and persist the choice for this assistant. */
  onViewModeChange: (next: SidebarViewMode) => void;

  /**
   * Every section in the user's chosen order. Sections the user has never
   * moved fall back to the default order (Pinned, custom groups, Chats, then
   * - in `grouped` view - the channel sections), which is a starting
   * arrangement rather than a constraint.
   *
   * The only list this hook publishes. Conversations that belong to no curated
   * section reach the sidebar as the Chats section's own contents, never as a
   * second collection beside `sections`: a consumer handed both renders
   * whichever one it is not told to skip, on top of the section itself.
   */
  sections: SidebarSection[];
  /**
   * Persist a new section order. Takes the full ordered key list of the
   * sections currently on screen.
   */
  onReorderSections: (orderedKeys: string[]) => void;
  /**
   * Nudge one section one slot up (`-1`) or down (`+1`) - the keyboard- and
   * touch-reachable equivalent of dragging it, since HTML5 drag events fire
   * for neither.
   */
  onMoveSection: (key: string, delta: -1 | 1) => void;
  /**
   * Whether {@link SidebarState.onMoveSection} would actually move anything -
   * false only at the ends of the list, so the menu never offers a nudge that
   * does nothing.
   */
  canMoveSection: (key: string, delta: -1 | 1) => boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseSidebarStateParams {
  conversations: Conversation[];
  conversationGroups?: ConversationGroup[];
}

export function useSidebarState({
  conversations,
  conversationGroups,
}: UseSidebarStateParams): SidebarState {
  const assistantId = useActiveAssistantId();
  // --- Layout store hydration ---

  useEffect(() => {
    if (assistantId) {
      startTransition(() => {
        useSidebarLayoutStore.getState().setAssistantId(assistantId);
      });
    }
  }, [assistantId]);

  const sectionOrder = useSidebarLayoutStore.use.sectionOrder();
  const setSectionOrder = useSidebarLayoutStore.use.setSectionOrder();

  // Read straight from storage rather than through the layout store. The store
  // hydrates in an effect, so anything it owns renders as the default on the
  // first paint; the view mode decides which list the sidebar draws, making
  // that flash the most visible one. Subscribing instead means the stored
  // choice is there on the first paint, and a change in another window lands
  // here without a reload.
  const viewMode = useViewMode(assistantId);
  const setViewMode = useCallback(
    (next: SidebarViewMode) => {
      saveViewMode(assistantId, next);
    },
    [assistantId],
  );
  /* The daemon's section index: which sections exist and what their badges
     say, with no conversation rows. `null` when the assistant predates the
     endpoint or the read has not resolved, in which case existence keeps
     deriving from the loaded list below. */
  const indexSections = useSidebarSectionsQuery(assistantId);

  // --- Grouping (memoized per conversations reference) ---

  const grouped = useMemo(
    () =>
      groupConversations(conversations, {
        groups: conversationGroups,
        groupByChannel: viewMode === "grouped",
      }),
    [conversations, conversationGroups, viewMode],
  );

  // --- Section order ---

  // Default layout: Pinned, then the user's custom groups, then - in the
  // grouped view - Chats and the channel sections. Groups lead because they
  // are the deliberate, curated organization layer, and they hold their place
  // while channel sections come and go with traffic. In the flat view the
  // sections stop at the curated layer: everything else renders as one list
  // below them.
  /* This list decides which sections exist, and it is the only thing that
     does. A section's *contents* come from its own query, but every entry
     here renders: the move-up/move-down nudges count these entries, so an
     entry that renders nothing offers a move that swaps with something off
     screen. One predicate for membership and visibility, or the two drift.

     Membership has two sources and the branch below picks between them: the
     daemon's section index where it is served, and the loaded list
     otherwise. The fallback is accurate only while that list drains in full,
     which a windowed list does not do, so the index is what keeps existence
     correct there. A section cannot answer this for itself either way:
     emptiness has to be known before the list is built, and this hook cannot
     mount N queries for N groups. */
  const defaultSections = useMemo((): SidebarSection[] => {
    /* Which sections exist has two possible sources, never mixed within one
       render. When the daemon serves the section index, it is authoritative
       for existence AND for group metadata: it is one consistent snapshot,
       where existence-from-index with names-from-the-groups-query could
       disagree between fetches. The derived buckets stay as each section's
       `all` fallback rows either way. When the index is `null` (an assistant
       without the endpoint, or a read that has not resolved), existence
       derives from the loaded list in the branch below, the one
       implementation shared with every assistant that never serves the
       index. */
    if (indexSections !== null) {
      const list: SidebarSection[] = [];
      const bucketByGroupId = new Map(
        grouped.customGroups.map((g) => [g.id, g]),
      );
      const rowsByChannelId = new Map(
        grouped.channelSections.map((s) => [s.channelId, s.conversations]),
      );
      const pinnedRow = indexSections.find((s) => s.kind === "pinned");
      if (pinnedRow) {
        list.push({
          type: "pinned",
          key: "pinned",
          label: "Pinned",
          all: grouped.pinned,
          unread: pinnedRow.unread,
        });
      }
      const groupRows = indexSections
        .filter((s) => s.kind === "group")
        .sort((a, b) => a.sortPosition - b.sortPosition);
      for (const row of groupRows) {
        list.push({
          type: "group",
          key: row.groupId,
          label: row.name,
          all: bucketByGroupId.get(row.groupId)?.conversations ?? [],
          unread: row.unread,
          group: {
            id: row.groupId,
            name: row.name,
            icon: row.icon,
            conversations:
              bucketByGroupId.get(row.groupId)?.conversations ?? [],
          },
        });
      }
      /* The index buckets are disjoint, so the flat view's Chats is the
         native bucket plus every channel bucket, and the grouped view's is
         the native bucket alone. */
      const channelRows = indexSections
        .filter((s) => s.kind === "channel")
        .sort((a, b) => a.channelId.localeCompare(b.channelId));
      const chatsUnread =
        (indexSections.find((s) => s.kind === "chats")?.unread ?? 0) +
        (viewMode !== "grouped"
          ? channelRows.reduce((sum, row) => sum + row.unread, 0)
          : 0);
      list.push({
        type: "recents",
        key: "recents",
        label: RECENTS_SECTION_LABEL,
        all: grouped.recents,
        holdsChannels: viewMode !== "grouped",
        unread: chatsUnread,
      });
      if (viewMode === "grouped") {
        for (const row of channelRows) {
          list.push({
            type: "channel",
            key: channelSectionKey(row.channelId),
            label: getChannelLabel(row.channelId),
            all: rowsByChannelId.get(row.channelId) ?? [],
            channelId: row.channelId,
            unread: row.unread,
          });
        }
      }
      return list;
    }

    const list: SidebarSection[] = [];
    if (grouped.pinned.length > 0) {
      list.push({
        type: "pinned",
        key: "pinned",
        label: "Pinned",
        all: grouped.pinned,
      });
    }
    for (const group of grouped.customGroups) {
      list.push({
        type: "group",
        key: group.id,
        label: group.name,
        all: group.conversations,
        group,
      });
    }
    /* Chats exists in both views. It is the section that holds whatever the
       curated ones did not claim, and that is true however the rest of the
       list is arranged - in `all` view `groupConversations` is called with
       `groupByChannel: false`, so the channel conversations are already in
       here rather than in sections of their own.

       It used to be pushed only in `grouped` view, leaving `all` view to
       render the same conversations through a separate headerless path. That
       one list then had to be given a header and a card by hand every time
       the others got one, and silently missed both. */
    list.push({
      type: "recents",
      key: "recents",
      label: RECENTS_SECTION_LABEL,
      all: grouped.recents,
      holdsChannels: viewMode !== "grouped",
    });
    if (viewMode === "grouped") {
      for (const section of grouped.channelSections) {
        list.push({
          type: "channel",
          key: channelSectionKey(section.channelId),
          label: getChannelLabel(section.channelId),
          all: section.conversations,
          channelId: section.channelId,
        });
      }
    }
    return list;
  }, [
    viewMode,
    indexSections,
    grouped.pinned,
    grouped.customGroups,
    grouped.recents,
    grouped.channelSections,
  ]);

  const sections = useMemo((): SidebarSection[] => {
    const defaultKeys = defaultSections.map((s) => s.key);
    const ordered =
      sectionOrder.length === 0
        ? defaultKeys
        : mergeSectionOrder(defaultKeys, sectionOrder);
    const byKey = new Map(defaultSections.map((s) => [s.key, s]));
    return ordered.map((key) => byKey.get(key)!);
  }, [defaultSections, sectionOrder]);

  const onReorderSections = useCallback(
    (orderedKeys: string[]) => {
      setSectionOrder(nextStoredOrder(sectionOrder, orderedKeys));
    },
    [sectionOrder, setSectionOrder],
  );

  // The order `key` would land in after a nudge, or null when the nudge
  // changes nothing: `key` is already at that end of the orderable list.
  const orderAfterMove = useCallback(
    (key: string, delta: -1 | 1): string[] | null => {
      const current = sections.map((s) => s.key);
      const moved = moveSectionKey(current, key, delta);
      if (!moved) {
        return null;
      }
      if (moved.join("\0") === current.join("\0")) {
        return null;
      }
      return moved;
    },
    [sections],
  );

  const onMoveSection = useCallback(
    (key: string, delta: -1 | 1) => {
      const moved = orderAfterMove(key, delta);
      if (moved) {
        setSectionOrder(nextStoredOrder(sectionOrder, moved));
      }
    },
    [orderAfterMove, sectionOrder, setSectionOrder],
  );

  const canMoveSection = useCallback(
    (key: string, delta: -1 | 1) => orderAfterMove(key, delta) !== null,
    [orderAfterMove],
  );

  return {
    viewMode,
    onViewModeChange: setViewMode,
    sections,
    onReorderSections,
    onMoveSection,
    canMoveSection,
  };
}
