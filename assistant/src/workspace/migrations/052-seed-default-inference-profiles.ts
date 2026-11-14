import type { WorkspaceMigration } from "./types.js";

/**
 * RETIRED: this migration seeded default inference profiles
 * (`quality-optimized`, `balanced`, `cost-optimized`) into workspace
 * config — full Anthropic bodies when `llm.default.provider` was unset
 * (always, at migration time on a fresh hatch) and empty `{}` shells
 * otherwise. Fresh hatches therefore always carried three seeded
 * Anthropic-shaped profiles no matter which provider the user picked.
 *
 * Default profile CONTENT is code-owned (`config/default-profile-catalog.ts`)
 * and resolves through the effective profile view whether or not
 * `llm.profiles` carries an entry, so fresh hatches now leave
 * `llm.profiles` empty. Migration 126 strips previously seeded bodies down
 * to thin managed stubs on existing workspaces. The migration id stays in
 * the chain so already-applied workspaces keep a recorded run; the run
 * itself is a no-op.
 */
export const seedDefaultInferenceProfiles052: WorkspaceMigration = {
  id: "052-seed-default-inference-profiles",
  description:
    "Seed default inference profiles (quality-optimized, balanced, cost-optimized) and activeProfile",
  run(_workspaceDir: string): void {
    // No-op: profiles resolve from the code catalog; nothing is seeded.
  },
  down(_workspaceDir: string): void {
    // Nothing to roll back — this migration no longer writes anything.
  },
};
