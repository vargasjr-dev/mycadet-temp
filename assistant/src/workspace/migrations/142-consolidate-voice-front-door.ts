import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isPlainObject } from "../../util/object.js";
import type { WorkspaceMigration } from "./types.js";

const OLD_CALLSITE = "voiceFrontDecision";
const PROGRESS_CALLSITE = "voiceProgressNarration";
const RETIRED_ACK_KEYS = [
  "ackFirstDeltaTimeoutMs",
  "ackGenerationTimeoutMs",
] as const;

export const consolidateVoiceFrontDoorMigration: WorkspaceMigration = {
  id: "142-consolidate-voice-front-door",
  description:
    "Rename the progress narration callsite and remove retired generated-ack tuning",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!isPlainObject(raw)) {
        return;
      }
      config = raw;
    } catch {
      return;
    }

    let changed = false;
    const llm = readObject(config.llm);
    const callSites = readObject(llm?.callSites);
    if (callSites && Object.hasOwn(callSites, OLD_CALLSITE)) {
      if (!Object.hasOwn(callSites, PROGRESS_CALLSITE)) {
        callSites[PROGRESS_CALLSITE] = callSites[OLD_CALLSITE];
      }
      delete callSites[OLD_CALLSITE];
      changed = true;
    }

    const liveVoice = readObject(config.liveVoice);
    const frontModel = readObject(liveVoice?.frontModel);
    if (frontModel) {
      for (const key of RETIRED_ACK_KEYS) {
        if (Object.hasOwn(frontModel, key)) {
          delete frontModel[key];
          changed = true;
        }
      }
    }

    if (changed) {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    }
  },
  down(_workspaceDir: string): void {
    // Forward-only.
  },
};

function readObject(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    return null;
  }
  return value;
}
