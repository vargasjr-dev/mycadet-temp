import type { DrizzleDb } from "../persistence/db-connection.js";
import { CADET_CLOUD_PROVIDER } from "../providers/cadet-model-routing.js";
import { PROVIDERS_REQUIRING_BASE_URL_AND_MODELS } from "../providers/inference/auth.js";
import {
  createConnection,
  getConnection,
  MANAGED_CONNECTION_NAMES,
} from "../providers/inference/connections.js";
import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import { credentialKey } from "../security/credential-key.js";
import { getLogger } from "../util/logger.js";
import {
  getEffectiveProfilesForProvider,
  MANAGED_PROFILE_NAMES,
  MANAGED_PROFILE_TEMPLATES,
} from "./default-profile-catalog.js";
import { getIsCloud } from "./env-registry.js";
import { loadConfig, loadRawConfig, saveRawConfig } from "./loader.js";
import { isDispatchableProfile } from "./profile-dispatchability.js";
import {
  isDefaultProviderChoice,
  type LLMConfig,
  type ProfileEntry,
} from "./schemas/llm.js";

const log = getLogger("seed-inference-profiles");

export const OS_BETA_FEATURE_FLAG_KEY = "os-beta";

const MIX_MIN_ARMS = 2;

export type SeedInferenceProfilesOptions = {
  preserveActiveProfile?: boolean;
  /** True when a hatch overlay was consumed this startup. */
  isHatch?: boolean;
  /** DB handle for creating user provider connections at hatch time. */
  db?: DrizzleDb;
};

/**
 * Seed inference profiles into the workspace config.
 *
 * Runs on every daemon startup. Default profile CONTENT is code-owned
 * (`default-profile-catalog.ts`) and resolves through the effective view
 * whether or not `llm.profiles` carries an entry, so nothing here writes
 * default bodies. Three responsibilities remain:
 *
 * 1. **Personal provider connection**: a BYOK hatch creates the
 *    `<provider>-personal` connection backed by the user's API key in CES.
 *    The BYOK columns of the intent × provider matrix stamp exactly that
 *    connection name (via `resolveDefaultConnectionName`), so the default
 *    profiles dispatch through it. Skipped for the cloud provider — the
 *    `cadet` column routes through the canonical platform-backed row, never
 *    a user key, so no `cadet-personal` connection exists or is needed.
 *
 * 2. **`llm.default`**: the base blob's `provider` field is written once at
 *    hatch time, mirroring the cloud/managed/BYOK decision, and never
 *    overwritten afterward. The default profiles resolve through this
 *    provider's matrix column.
 *
 * 3. **Active/advisor profile resolution**: hatches activate `balanced`;
 *    boots repair dangling or disabled selections.
 */
export function seedInferenceProfiles(
  options: SeedInferenceProfilesOptions = {},
): void {
  const config = loadConfig();
  const llm = config.llm;
  const profiles = llm.profiles;

  const isCloud = getIsCloud();

  // A hatch overlay that explicitly selected a cloud connection routes the
  // default provider through cadet rather than the entered BYOK key.
  const hatchSelectedManagedConnection = didHatchSelectManagedConnection(
    llm,
    profiles,
    options,
  );

  // 1. Personal provider connection: only at hatch time for off-cloud
  //    installations, backed by the user's API key in CES. The BYOK columns
  //    of the intent × provider matrix stamp `<provider>-personal` (via
  //    `resolveDefaultConnectionName`), so the connection must exist for the
  //    default profiles to dispatch.
  let usableHatchProvider: string | undefined;
  if (options.isHatch && !isCloud) {
    // The hatch overlay writes `llm.default.provider` directly.
    const hatchProvider = llm.default?.provider;
    if (
      hatchProvider &&
      hatchProvider !== CADET_CLOUD_PROVIDER &&
      hatchProvider !== "ollama" &&
      !PROVIDERS_REQUIRING_BASE_URL_AND_MODELS.has(hatchProvider)
    ) {
      usableHatchProvider = hatchProvider;
      // Same predicate `resolveHatchDefaultProvider` applies below: a
      // provider can pass the connection gate (key stored, personal
      // connection created) yet not qualify as a default-provider choice
      // (e.g. openai-compatible, whose catalog defaultModel is empty).
      // Surface that divergence here, at the point the connection is still
      // created.
      if (!isDefaultProviderChoice(hatchProvider)) {
        log.warn(
          { provider: hatchProvider },
          "Hatch provider key stored and personal connection created, but the provider cannot back the default profiles; llm.default will fall back to anthropic",
        );
      }
      const userConnectionName = `${hatchProvider}-personal`;

      if (options.db && !getConnection(options.db, userConnectionName)) {
        const credName = credentialKey(hatchProvider, "api_key");
        const result = createConnection(options.db, {
          name: userConnectionName,
          provider: hatchProvider,
          auth: { type: "api_key", credential: credName },
          label: personalConnectionLabel(hatchProvider),
        });
        if (!result.ok) {
          log.warn(
            { provider: hatchProvider, error: result.error },
            "Failed to create personal connection during hatch seeding",
          );
        }
      }
    }
  }

  // 2. Default provider: hatch only, never overwritten once set. Always
  //    populated — even dangling, so later resolution can prompt the user
  //    for a key explainably rather than hitting an unset branch.
  const blob = llm.default;
  const blobProvider = blob?.provider;
  if (
    options.isHatch &&
    (blobProvider == null || !isDefaultProviderChoice(blobProvider))
  ) {
    llm.default = {
      ...blob,
      provider: resolveHatchDefaultProvider(
        isCloud,
        hatchSelectedManagedConnection,
        usableHatchProvider,
      ),
    };
  }

  pruneNonDispatchableProfiles(llm, profiles);

  // Profile lookups below go through the effective view: a default profile
  // resolves from the code catalog whether or not the workspace carries a
  // stub for it, and a stub contributes only its status/label overlays.
  // Resolved against `llm.default` so the cloud backups count as
  // available only on the cloud column, matching what the schema accepts
  // as a reference: an `activeProfile` naming a backup on a BYOK install
  // fails the typed load's leaf recovery, reads here as no selection, and
  // is repaired to `balanced` below.
  const effectiveProfiles = getEffectiveProfilesForProvider(llm);

  // Active profile resolution.
  const requestedActiveProfile = llm.activeProfile;
  const requestedActiveEntry =
    requestedActiveProfile !== undefined
      ? effectiveProfiles[requestedActiveProfile]
      : undefined;
  const requestedActiveExists = requestedActiveEntry !== undefined;
  const shouldPreserveActiveProfile =
    options.preserveActiveProfile === true && requestedActiveExists;

  if (!shouldPreserveActiveProfile) {
    if (options.isHatch || !requestedActiveExists) {
      llm.activeProfile = "balanced";
    }
  }

  // Advisor profile: defaults to the strongest active managed default.
  const requestedAdvisorProfile = llm.advisorProfile;
  const requestedAdvisorEntry =
    requestedAdvisorProfile !== undefined
      ? effectiveProfiles[requestedAdvisorProfile]
      : undefined;
  const requestedAdvisorIsDisabledManaged =
    requestedAdvisorEntry?.source === "managed" &&
    requestedAdvisorEntry.status === "disabled";
  if (
    requestedAdvisorProfile === undefined ||
    requestedAdvisorIsDisabledManaged
  ) {
    const defaultAdvisorProfile = firstActiveCloudProfile(effectiveProfiles, [
      "quality-optimized",
      "balanced",
      "cost-optimized",
    ]);
    if (defaultAdvisorProfile) {
      llm.advisorProfile = defaultAdvisorProfile;
    } else if (requestedAdvisorIsDisabledManaged) {
      delete llm.advisorProfile;
    }
  }

  // Profile ordering: ensure all seeded profiles appear in the order array.
  // A managed key absent from a workspace's order is placed next to the
  // sibling that precedes it in the catalog rather than appended, so the
  // cloud profiles stay grouped in catalog order even on a workspace whose
  // order already lists custom profiles. Entries already in the order keep
  // their relative positions, so a user arrangement survives.
  const profileOrder = [...llm.profileOrder];
  const managedNames = Object.keys(MANAGED_PROFILE_TEMPLATES);
  for (const [index, name] of managedNames.entries()) {
    if (profileOrder.includes(name)) {
      continue;
    }
    const anchor = managedNames
      .slice(0, index)
      .reverse()
      .map((sibling) => profileOrder.indexOf(sibling))
      .find((position) => position >= 0);
    if (anchor === undefined) {
      profileOrder.push(name);
    } else {
      profileOrder.splice(anchor + 1, 0, name);
    }
  }
  llm.profileOrder = profileOrder;

  // Tag any remaining profiles without a source as user-created.
  for (const [name, profile] of Object.entries(profiles)) {
    if (MANAGED_PROFILE_NAMES.has(name)) {
      continue;
    }
    profile.source ??= "user";
  }

  // Persist: the seed only ever rewrites the `llm` section, so the typed
  // view's `llm` lands on the raw base verbatim and every other section the
  // user has on disk survives untouched.
  const raw = loadRawConfig();
  raw.llm = llm;
  saveRawConfig(raw);
}

export function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resolveHatchDefaultProvider(
  isCloud: boolean,
  selectedManagedConnection: boolean,
  hatchProvider: string | undefined,
): string {
  // Platform mode and an explicit managed-connection selection both route
  // through cadet.
  if (isCloud || selectedManagedConnection) {
    return "cadet";
  }
  if (hatchProvider !== undefined && isDefaultProviderChoice(hatchProvider)) {
    return hatchProvider;
  }
  log.warn(
    { provider: hatchProvider ?? null },
    "Hatch provider cannot back the default profiles; falling back to anthropic",
  );
  return "anthropic";
}

function pruneNonDispatchableProfiles(
  llm: LLMConfig,
  profiles: Record<string, ProfileEntry>,
): void {
  const removed = new Set<string>();
  for (const [name, profile] of Object.entries(profiles)) {
    // Thin managed stubs carry no model/mix by design — their content is
    // code-owned, so dispatchability is judged on the catalog body, never
    // the stub. Only workspace-owned profiles are pruned.
    if (MANAGED_PROFILE_NAMES.has(name) && profile.source === "managed") {
      continue;
    }
    if (!isDispatchableProfile(profile)) {
      delete profiles[name];
      removed.add(name);
    }
  }
  pruneRemovedProfileReferences(llm, profiles, removed);
}

function pruneRemovedProfileReferences(
  llm: LLMConfig,
  profiles: Record<string, ProfileEntry>,
  removed: Set<string>,
): void {
  if (removed.size === 0) {
    return;
  }

  let cascading = true;
  while (cascading) {
    cascading = false;
    for (const [name, profile] of Object.entries(profiles)) {
      if (removed.has(name)) {
        continue;
      }
      if (profile.mix == null) {
        continue;
      }
      const kept = profile.mix.filter((arm) => !removed.has(arm.profile));
      if (kept.length === profile.mix.length) {
        continue;
      }
      if (kept.length >= MIX_MIN_ARMS) {
        profile.mix = kept;
      } else {
        delete profiles[name];
        removed.add(name);
      }
      cascading = true;
    }
  }

  llm.profileOrder = llm.profileOrder.filter((name) => !removed.has(name));

  if (llm.advisorProfile !== undefined && removed.has(llm.advisorProfile)) {
    delete llm.advisorProfile;
  }

  for (const entry of Object.values(llm.callSites)) {
    if (entry.profile !== undefined && removed.has(entry.profile)) {
      delete entry.profile;
    }
  }
}

function firstActiveCloudProfile(
  profiles: Record<string, ProfileEntry>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const profile = profiles[name];
    if (profile?.source === "managed" && profile.status !== "disabled") {
      return name;
    }
  }
  return undefined;
}

function didHatchSelectManagedConnection(
  llm: LLMConfig,
  profiles: Record<string, ProfileEntry>,
  options: SeedInferenceProfilesOptions,
): boolean {
  if (!options.isHatch || options.preserveActiveProfile !== true) {
    return false;
  }

  const activeProfile = llm.activeProfile;
  if (!activeProfile) {
    return false;
  }

  const explicitConnection = profiles[activeProfile]?.provider_connection;
  if (explicitConnection !== undefined) {
    return MANAGED_CONNECTION_NAMES.has(explicitConnection);
  }

  // A default-profile name with no explicit connection selects the cloud
  // route: the cadet column IS the cloud column, and its profiles route
  // through the canonical cadet row.
  return MANAGED_PROFILE_TEMPLATES[activeProfile] !== undefined;
}

/**
 * Format the human-readable label seeded onto a personal provider connection
 * at hatch time, e.g. `"Anthropic (Personal)"`. The display name is sourced
 * from `PROVIDER_CATALOG` so it tracks the canonical provider directory; an
 * unrecognised provider id falls back to the raw id with the suffix.
 */
function personalConnectionLabel(providerId: string): string {
  const displayName =
    PROVIDER_CATALOG.find((p) => p.id === providerId)?.displayName ??
    providerId;
  return `${displayName} (Personal)`;
}
