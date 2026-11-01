import { isSkillCompatibleWithCloud } from "../skills/cloud-compatibility.js";
import type { AssistantConfig } from "./schema.js";
import { SkillEntryConfig } from "./schemas/skills.js";
import type { SkillSummary } from "./skills.js";

export type SkillState = "enabled" | "disabled";

export interface ResolvedSkill {
  summary: SkillSummary;
  state: SkillState;
  configEntry?: SkillEntryConfig;
}

export function resolveSkillStates(
  catalog: SkillSummary[],
  config: AssistantConfig,
): ResolvedSkill[] {
  const results: ResolvedSkill[] = [];
  const { entries, allowBundled } = config.skills ?? {
    entries: {},
    allowBundled: null,
  };

  for (const skill of catalog) {
    if (!isSkillCompatibleWithCloud(skill)) {
      continue;
    }

    // Filter bundled skills by allowlist
    if (
      skill.source === "bundled" &&
      allowBundled != null &&
      !allowBundled.includes(skill.id)
    ) {
      continue;
    }

    const configKey = skill.id;
    const entry = entries[configKey];

    // Determine enabled state
    let isEnabled: boolean;
    if (entry && typeof entry.enabled === "boolean") {
      isEnabled = entry.enabled;
    } else {
      // Default: bundled, managed (user-installed), and plugin-contributed
      // skills are enabled. Others (workspace, extra) are disabled by default.
      isEnabled =
        skill.source === "bundled" ||
        skill.source === "managed" ||
        skill.source === "plugin";
    }

    if (!isEnabled) {
      results.push({
        summary: skill,
        state: "disabled",
        configEntry: entry,
      });
      continue;
    }

    results.push({
      summary: skill,
      state: "enabled",
      configEntry: entry,
    });
  }

  return results;
}
