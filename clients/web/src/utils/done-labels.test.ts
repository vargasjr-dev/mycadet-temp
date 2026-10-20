/**
 * The archive label set — the shared copy every archive surface reads.
 */

import { describe, expect, test } from "bun:test";
import { Archive, ArchiveRestore } from "lucide-react";

import { fixedT } from "@/i18n";
import { conversationDoneLabels } from "@/utils/done-labels";

const t = fixedT("chat");

describe("conversationDoneLabels", () => {
  test("the archive wording", () => {
    const labels = conversationDoneLabels(t);
    expect(labels.archive).toBe("Archive");
    expect(labels.unarchive).toBe("Unarchive");
    expect(labels.swipeArchive).toBe("Archive");
    expect(labels.archiveAll).toBe("Archive All…");
    expect(labels.archiveAllTitle).toBe("Archive All");
    expect(labels.archiveAllConfirm).toBe("Archive All");
    expect(labels.headerBadge).toBe("[Archived]");
  });

  test("the glyphs travel with the wording", () => {
    const labels = conversationDoneLabels(t);
    expect(labels.archiveIcon).toBe(Archive);
    expect(labels.unarchiveIcon).toBe(ArchiveRestore);
    expect(labels.archiveAllIcon).toBe(Archive);
  });

  test("the bulk confirmation tells users to search is:archived", () => {
    const vars = { count: 3, groupName: "PR Reviews" };
    const message = conversationDoneLabels(t).archiveAllMessage(vars);

    expect(message).toContain("is:archived");
    expect(message).toContain("PR Reviews");
    expect(message).toContain("3");
  });
});
