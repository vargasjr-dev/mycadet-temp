import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isPlainObject } from "../../util/object.js";
import type { WorkspaceMigration } from "./types.js";

/**
 * Backfill `services.tts.provider` and `services.tts.providers.*` from
 * legacy config keys, then remove the legacy keys.
 *
 * Legacy keys consulted:
 *  - `calls.voice.ttsProvider`  -> `services.tts.provider`
 *  - `elevenlabs.*`             -> `services.tts.providers.elevenlabs.*`
 *  - `fishAudio.*`              -> `services.tts.providers.fish-audio.*`
 *
 * In mixed legacy states, `calls.voice.ttsProvider` wins as the selected
 * provider. Provider-specific values are copied from the legacy top-level
 * sections into their canonical `services.tts.providers.*` locations.
 *
 * After copying, legacy fields are removed so no compatibility shim is
 * required in the runtime resolver.
 *
 * Idempotent: re-running the migration on an already-migrated config
 * produces no changes.
 */
export const ttsProviderUnificationMigration: WorkspaceMigration = {
  id: "032-tts-provider-unification",
  description:
    "Backfill services.tts.provider and services.tts.providers.* from legacy TTS config keys, then remove legacy keys",
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
      return; // Malformed config — skip
    }

    // Resolve legacy TTS provider from calls.voice.ttsProvider
    const legacyProvider = resolveLegacyProvider(config);

    // Resolve legacy provider-specific configs
    const legacyElevenlabs = extractLegacyElevenlabs(config);
    const legacyFishAudio = extractLegacyFishAudio(config);

    // If no legacy data exists, nothing to migrate
    if (!legacyProvider && !legacyElevenlabs && !legacyFishAudio) {
      return;
    }

    // Ensure services.tts exists
    const services = ensureObj(config, "services");
    const tts = ensureObj(services, "tts");

    // Set provider if not already explicitly set
    if (!("provider" in tts) && legacyProvider) {
      tts.provider = legacyProvider;
    }

    // Set mode to your-own (always)
    if (!("mode" in tts)) {
      tts.mode = "your-own";
    }

    // Backfill providers map
    const providers = ensureObj(tts, "providers");

    if (legacyElevenlabs) {
      const elTarget = ensureObj(providers, "elevenlabs");
      // Only copy keys that are not already present in canonical
      for (const [key, value] of Object.entries(legacyElevenlabs)) {
        if (!(key in elTarget)) {
          elTarget[key] = value;
        }
      }
    }

    if (legacyFishAudio) {
      const faTarget = ensureObj(providers, "fish-audio");
      for (const [key, value] of Object.entries(legacyFishAudio)) {
        if (!(key in faTarget)) {
          faTarget[key] = value;
        }
      }
    }

    // Clean up legacy fields — canonical paths are now fully materialised.
    // Remove calls.voice.ttsProvider (but preserve the rest of calls.voice)
    removeLegacyTtsProvider(config);
    // Remove top-level elevenlabs and fishAudio sections
    delete config.elevenlabs;
    delete config.fishAudio;

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(workspaceDir: string): void {
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

    // Restore legacy keys from canonical services.tts before removing it.
    const services = config.services;
    if (isPlainObject(services)) {
      const servicesObj = services;
      const tts = servicesObj.tts;
      if (isPlainObject(tts)) {
        const ttsObj = tts;

        // Restore calls.voice.ttsProvider from services.tts.provider
        const provider = ttsObj.provider;
        if (typeof provider === "string") {
          const calls = ensureObj(config, "calls");
          const voice = ensureObj(calls, "voice");
          voice.ttsProvider = provider;
        }

        // Restore top-level elevenlabs and fishAudio from providers map
        const providers = ttsObj.providers;
        if (isPlainObject(providers)) {
          const providersObj = providers;

          const elConfig = providersObj.elevenlabs;
          if (isPlainObject(elConfig)) {
            config.elevenlabs = { ...elConfig };
          }

          const faConfig = providersObj["fish-audio"];
          if (isPlainObject(faConfig)) {
            config.fishAudio = { ...faConfig };
          }
        }
      }

      delete servicesObj.tts;
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureObj(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  if (
    !(key in parent) ||
    parent[key] == null ||
    typeof parent[key] !== "object" ||
    Array.isArray(parent[key])
  ) {
    parent[key] = {};
  }
  return parent[key] as Record<string, unknown>;
}

/** Extract legacy provider selection from calls.voice.ttsProvider. */
function resolveLegacyProvider(config: Record<string, unknown>): string | null {
  const calls = config.calls;
  if (!isPlainObject(calls)) {
    return null;
  }
  const callsObj = calls;

  const voice = callsObj.voice;
  if (!isPlainObject(voice)) {
    return null;
  }
  const voiceObj = voice;

  const provider = voiceObj.ttsProvider;
  return typeof provider === "string" ? provider : null;
}

/** Remove calls.voice.ttsProvider from config while preserving other voice fields. */
function removeLegacyTtsProvider(config: Record<string, unknown>): void {
  const calls = config.calls;
  if (!isPlainObject(calls)) {
    return;
  }
  const callsObj = calls;

  const voice = callsObj.voice;
  if (!isPlainObject(voice)) {
    return;
  }
  const voiceObj = voice;

  delete voiceObj.ttsProvider;
}

/** Extract legacy ElevenLabs config from top-level elevenlabs object. */
function extractLegacyElevenlabs(
  config: Record<string, unknown>,
): Record<string, unknown> | null {
  const el = config.elevenlabs;
  if (!isPlainObject(el)) {
    return null;
  }
  const obj = el;
  // Only return if there are non-empty keys
  return Object.keys(obj).length > 0 ? { ...obj } : null;
}

/** Extract legacy Fish Audio config from top-level fishAudio object. */
function extractLegacyFishAudio(
  config: Record<string, unknown>,
): Record<string, unknown> | null {
  const fa = config.fishAudio;
  if (!isPlainObject(fa)) {
    return null;
  }
  const obj = fa;
  return Object.keys(obj).length > 0 ? { ...obj } : null;
}
