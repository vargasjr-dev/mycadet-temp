import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readDefaultProvider } from "../config/default-provider-resolution.js";
import { getIsPlatform } from "../config/env-registry.js";
import { invalidateConfigCache } from "../config/loader.js";
import { isDefaultProviderChoice } from "../config/schemas/llm.js";
import { hasManagedProxyPrereqs } from "../providers/platform-proxy/context.js";

// Ensures the `llm.default` blob carries a usable default provider on every
// boot.
//
// Existing installs that never ran the hatch flow need a provider
// backfilled. This is split across two pieces with workspace migration 127:
//   - The migration applies only synchronously-readable signals (a legacy
//     base-config blob, or a personal `custom-*` profile's provider)
//     and checkpoints before `mergeDefaultWorkspaceConfig()` merges the
//     platform overlay in daemon/lifecycle.ts. An overlay merged afterward
//     can rewrite `llm`, so the migration alone can't guarantee the blob
//     survives.
//   - This ensure pass re-applies the same signals (platform first, then
//     the sync signals), plus a login fallback ("logged in to the
//     platform" is `hasManagedProxyPrereqs()`, an async secure-vault read
//     that a sync migration cannot perform). It runs unconditionally on every boot
//     (not gated on whether a platform overlay was merged this run) so it
//     also repairs hand-deleted fields and configs restored from backups.
//
// Three states, in order:
//   1. A valid retired `llm.defaultProvider` key (a #134-era hatch overlay
//      or PUT) is newer intent than the blob — the #37740..#134 era routed
//      every selection write through it. The selection is STAMPED into the
//      blob (preserving the blob's other fields) and the key is deleted in
//      the same write, so the blob is the only selection surface left on
//      disk. An explicit `connectionName` rides along as
//      `provider_connection`; without one, an existing pin survives only
//      while the provider is unchanged (a pin naming the old provider's
//      connection would otherwise mis-pin the new column). This is the
//      runtime-side heal for post-#134 hatches and both-keys configs; the
//      vellum-to-cadet migrator performs the same conversion for migrated
//      installs.
//   2. A valid blob provider with no key: nothing to do. The blob's
//      `provider` is trusted as intent — including a bare "anthropic"
//      (an old first-launch seed echoed that default into the base config,
//      which routed anthropic then and routes anthropic now; the old
//      echo-disambiguation existed to keep the echo out of the KEY, not out
//      of the blob it was copied from).
//   3. Neither: resolve a provider (platform → custom-* profiles → login
//      fallback) and write it. The legacy blob read that used to feed an
//      "anthropic echo" disambiguation here is gone: state 2's gate accepts
//      every resolvable provider before resolution runs, so resolution only
//      sees blobs with no usable provider and the disambiguation had no
//      case left to decide.
//
// Idempotent: the resolution path never writes a connection pin —
// convention resolution (`resolveDefaultConnectionName`) owns the name —
// and never overwrites a usable blob provider (an invalid blob is dropped
// by the read clamp, so replacing it is repair, not overwrite).

// Historical repair signal only: the BYOK conversion pass
// (byok-default-profile-ensure.ts) retires unedited `custom-*` copies, so on
// converted installs these names are gone and recovery of a hand-deleted
// selection falls through to `loginFallback`.
const CUSTOM_PROFILE_ORDER = [
  "custom-balanced",
  "custom-quality-optimized",
  "custom-cost-optimized",
] as const;

export async function ensureDefaultProvider(
  workspaceDir: string,
): Promise<void> {
  const configPath = join(workspaceDir, "config.json");
  if (!existsSync(configPath)) {
    return;
  }

  let config: Record<string, unknown>;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return;
    }
    config = raw as Record<string, unknown>;
  } catch {
    return;
  }

  const llm = readObject(config.llm) ?? {};
  const blob = readObject(llm.default);
  const blobProvider = readDefaultProvider(blob);
  const key = readSelectionKey(llm.defaultProvider);

  const write = (): void => {
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    // The lifecycle call site runs before the first loadConfig() of this boot,
    // so no cached config exists yet to invalidate; this call guards callers
    // that read config before that first load (and any future reordering).
    invalidateConfigCache();
  };

  // 1. Key-wins stamp (see the header for the ordering rationale).
  if (key) {
    const next: Record<string, unknown> = {
      ...(blob ?? {}),
      provider: key.provider,
    };
    if (key.connectionName) {
      next.provider_connection = key.connectionName;
    } else if (blob?.provider !== key.provider) {
      delete next.provider_connection;
    }
    llm.default = next;
    delete llm.defaultProvider;
    write();
    return;
  }

  // 2. Valid blob: nothing to derive. Lingering invalid key bytes (a key
  //    that failed the clamp) are retired with the same write.
  if (blobProvider) {
    if (llm.defaultProvider !== undefined) {
      delete llm.defaultProvider;
      write();
    }
    return;
  }

  // 3. No usable selection anywhere: resolve one.
  const provider = await resolveProvider(llm);
  llm.default = { ...(blob ?? {}), provider };
  // An invalid key's raw bytes are retired with the same write.
  delete llm.defaultProvider;
  write();
}

async function resolveProvider(llm: Record<string, unknown>): Promise<string> {
  if (getIsPlatform()) {
    return "cadet";
  }

  const profiles = readObject(llm.profiles);
  if (profiles !== null) {
    for (const name of CUSTOM_PROFILE_ORDER) {
      const entry = readObject(profiles[name]);
      if (entry === null) {
        continue;
      }
      const provider = entry.provider;
      if (typeof provider !== "string") {
        continue;
      }
      return isDefaultProviderChoice(provider)
        ? provider
        : await loginFallback();
    }
  }

  return await loginFallback();
}

/**
 * The retired `llm.defaultProvider` key's shape, strictly validated: the
 * provider must name a matrix column and the pin, when present, must be a
 * non-empty string. Strict on purpose — this is a validity GATE (a malformed
 * key must fall to the resolution chain and be repaired), where the blob
 * read is lenient because a live blob must never be dropped over a bad pin.
 */
function readSelectionKey(
  value: unknown,
): { provider: string; connectionName?: string } | null {
  const key = readObject(value);
  if (key === null) {
    return null;
  }
  const provider = key.provider;
  if (typeof provider !== "string" || !isDefaultProviderChoice(provider)) {
    return null;
  }
  const connectionName = key.connectionName;
  if (connectionName !== undefined) {
    if (typeof connectionName !== "string" || connectionName === "") {
      return null;
    }
    return { provider, connectionName };
  }
  return { provider };
}

async function loginFallback(): Promise<string> {
  if (await hasManagedProxyPrereqs()) {
    return "cadet";
  }
  return "anthropic";
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
