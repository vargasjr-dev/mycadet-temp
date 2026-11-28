import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getBundledSkillsDir } from "../config/skills.js";
import { getWorkspaceSkillsDir } from "../util/layout.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("workspace-seed");

/**
 * Skill ids materialized into the workspace skills directory at daemon
 * startup. These are skills that must be present and model-editable on every
 * device with no install step, so they ship as seed content instead of
 * read-only bundled skills. Source content lives under the bundled-skills
 * asset dir at `_seeds/<id>/SKILL.md` and rides the existing packaged copy.
 */
const SEED_SKILL_IDS = ["visualize"] as const;

/**
 * Write-if-missing materialization of seed skills into the workspace. A file
 * the user has edited or removed is never overwritten or resurrected beyond
 * the initial write; disabling happens through skill config, not deletion.
 */
export function ensureWorkspaceSeedSkills(): void {
  for (const id of SEED_SKILL_IDS) {
    const dest = join(getWorkspaceSkillsDir(), id, "SKILL.md");
    if (existsSync(dest)) {
      continue;
    }

    const src = join(getBundledSkillsDir(), "_seeds", id, "SKILL.md");
    if (!existsSync(src)) {
      continue;
    }

    try {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(src));
      log.info({ skillId: id, dest }, "Seeded workspace skill");
    } catch (err) {
      log.warn({ err, skillId: id }, "Failed to seed workspace skill");
    }
  }
}
