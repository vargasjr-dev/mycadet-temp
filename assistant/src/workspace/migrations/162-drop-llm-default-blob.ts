import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isDefaultProviderChoice } from "../../config/schemas/llm.js";
import type { WorkspaceMigration } from "./types.js";

/**
 * Drop the legacy `llm.default` base-config blob from config.json.
 *
 * Two eras of config shared the `llm` section: the pre-refactor base object
 * (`llm.default`: provider, model, sampling params — the base profiles and
 * call sites inherited from) and the profile matrix's `llm.defaultProvider`
 * column selector, which replaced resolution entirely: the schema dropped
 * `llm.default` and single-winner profile selection is the only path. The
 * raw-blob readers that migrated old intent forward kept the blob alive on
 * disk; with those readers gone, this migration removes the last trace so
 * config.json carries exactly one default-provider shape.
 *
 * A blob whose provider names a valid default-provider choice and whose
 * `llm.defaultProvider` is somehow still unset writes that choice first, so
 * the install's intent survives the deletion; anything else the blob carried
 * was already materialized (profiles, connections) by the seeding passes.
 */
export const dropLlmDefaultBlobMigration: WorkspaceMigration = {
  id: "162-drop-llm-default-blob",
  description:
    "Remove the legacy llm.default base-config blob from config.json",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }
    const rawText = readFileSync(configPath, "utf-8");
    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(rawText);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return;
      }
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const llm = readObject(config.llm);
    if (llm === null || readObject(llm.default) === null) {
      return;
    }
    if (readObject(llm.defaultProvider) === null) {
      const provider = readString(readObject(llm.default)?.provider);
      if (provider !== undefined && isDefaultProviderChoice(provider)) {
        llm.defaultProvider = { provider };
      }
    }
    delete llm.default;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(): void {},
};

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
