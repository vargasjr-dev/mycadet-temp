/**
 * Test-only utilities for seeding the feature flag override cache.
 *
 * Replaces the removed `_setOverridesForTesting` export from
 * `assistant-feature-flags.ts`. Lives here (not in the source module)
 * because production modules should not expose test backdoors.
 *
 * No source-module imports
 * ------------------------
 * This file has ZERO runtime imports from `src/`. It accesses the feature flag
 * cache's state via the shared `globalThis.cadetAssistant.featureFlagCache`
 * slot that `src/config/feature-flag-cache.ts` also reads/writes, typed by the
 * shared ambient `CadetFeatureFlagCache` (declared in
 * `src/mycadet-namespace.d.ts`). That ambient type is pure
 * compile-time information — referencing it adds nothing to this file's runtime
 * import graph — so keeping the helper off the production import graph (what
 * protects the test preload from a broken `node_modules` symlink, DB ghost #3)
 * still holds.
 */

function flagSlot(): CadetFeatureFlagCache {
  const ns = (globalThis.cadetAssistant ??= {});
  return (ns.featureFlagCache ??= { overrides: null, fromGateway: false });
}

/**
 * Synchronously seed the feature flag override cache for the current test.
 *
 * Sets the cache to a clone of `overrides` and marks it as
 * gateway-populated, so subsequent `initFeatureFlagOverrides()` calls are
 * no-ops (preventing the production retry loop from running during tests).
 *
 * Tests that want the gateway IPC retry path to actually run should not
 * call this — they should leave the cache empty or call
 * `clearFeatureFlagOverridesCache()` from `assistant-feature-flags.ts`.
 */
export function setOverridesForTesting(
  overrides: Record<string, boolean | string>,
): void {
  const s = flagSlot();
  s.overrides = { ...overrides };
  s.fromGateway = true;
}

/**
 * Registry keys whose `defaultEnabled` is `true`. Tests that previously mocked
 * `isAssistantFeatureFlagEnabled` to a blanket `() => false` must override
 * these explicitly — the real module resolves them to `true` otherwise.
 */
export const DEFAULT_ENABLED_FLAG_KEYS: readonly string[] = [
  "in-chat-onboarding-tour",
  "vision-mode",
];

/**
 * Equivalent of a blanket `isAssistantFeatureFlagEnabled: () => false` mock:
 * every default-enabled key is overridden to `false`, so all flags resolve
 * off through the real resolution path.
 */
export function setAllFlagsOffForTesting(): void {
  setOverridesForTesting(
    Object.fromEntries(DEFAULT_ENABLED_FLAG_KEYS.map((k) => [k, false])),
  );
}

/** Every key declared in the feature-flag registry. */
export const ALL_REGISTRY_FLAG_KEYS: readonly string[] = [
  "in-chat-onboarding-tour",
  "vision-mode",
  "cadet-hosted-inference",
  "quiet-turn-activity",
  "fast-mode",
  "internal-thread-actions",
  "teach",
  "velvet",
  "os-beta",
  "chat-credential-reveal",
  "marketing-pricing-takeover",
  "push-avatar-sender",
  "local-notification-avatar",
  "model-first-profile-create",
  "send-user-message",
  "sidebar-done",
];

/**
 * Equivalent of a blanket `isAssistantFeatureFlagEnabled: () => true` mock for
 * every declared registry key (undeclared keys still fail closed, matching the
 * real resolution).
 */
export function setAllFlagsOnForTesting(): void {
  setOverridesForTesting(
    Object.fromEntries(ALL_REGISTRY_FLAG_KEYS.map((k) => [k, true])),
  );
}
