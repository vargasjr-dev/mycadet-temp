
import type { WorkspaceMigration } from "./types.js";

/**
 * Historic no-op. This migration seeded a latency-optimized default for
 * the `conversationStarters` LLM call site (the personalized starter
 * chips on the empty conversation page). That feature has since been
 * removed outright — the chips, their generating job, and the call site
 * itself no longer exist, and the config schema rejects unknown call
 * sites, so seeding would brick fresh installs with an orphan key.
 *
 * The step stays registered (forward-only: applied workspaces record
 * this id) but writes nothing.
 */
export const seedConversationStartersCallsiteMigration: WorkspaceMigration = {
  id: "046-seed-conversation-starters-callsite",
  description:
    "Historic no-op — seeded the removed conversationStarters call site",
  run(_workspaceDir: string): void {
    // No-op — the call site is gone (see the doc comment above). The
    // body is intentionally empty.
  },
  down(_workspaceDir: string): void {
    // Forward-only.
  },
};
