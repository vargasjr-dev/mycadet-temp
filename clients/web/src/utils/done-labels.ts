/**
 * The archive wording every surface shares — the row menu, the header
 * dropdown, the swipe action, the bulk confirmation — read from one place so
 * the wording cannot drift.
 */

import { Archive, ArchiveRestore, type LucideIcon } from "lucide-react";

import { useTranslation, type TFunction } from "@/i18n";

/**
 * Every string and glyph whose wording depends on the flag, already resolved.
 *
 * The icons travel with the labels rather than beside them, because a menu
 * row reading "Mark as done" next to an archive box is the drift this module
 * exists to prevent.
 */
export interface ConversationDoneLabels {
  /** Row menu, header dropdown: files the conversation away. */
  archive: string;
  archiveIcon: LucideIcon;
  /** Row menu, header dropdown: brings it back. */
  unarchive: string;
  unarchiveIcon: LucideIcon;
  /** Swipe-to-reveal action on a touch row, which has room for one word. */
  swipeArchive: string;
  /** Section header menu: the bulk action. */
  archiveAll: string;
  archiveAllIcon: LucideIcon;
  /** The bulk action's confirmation dialog. */
  archiveAllTitle: string;
  archiveAllConfirm: string;
  archiveAllMessage: (vars: { count: number; groupName: string }) => string;
  /** Prefix on the chat header's title for a filed conversation. */
  headerBadge: string;
}

export function conversationDoneLabels(
  t: TFunction<"chat">,
): ConversationDoneLabels {
  return {
    archive: t("conversationActions.archive"),
    archiveIcon: Archive,
    unarchive: t("conversationActions.unarchive"),
    unarchiveIcon: ArchiveRestore,
    swipeArchive: t("conversationActions.archive"),
    archiveAll: t("groupActions.archiveAll"),
    archiveAllIcon: Archive,
    archiveAllTitle: t("archiveAllConfirmDialog.title"),
    archiveAllConfirm: t("archiveAllConfirmDialog.confirm"),
    archiveAllMessage: (vars) => t("archiveAllConfirmDialog.message", vars),
    headerBadge: t("chatConversationHeader.archived"),
  };
}
export function useConversationDoneLabels(): ConversationDoneLabels {
  const { t } = useTranslation("chat");
  return conversationDoneLabels(t);
}
