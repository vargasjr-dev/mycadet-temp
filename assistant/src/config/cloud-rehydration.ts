/**
 * Rehydrate the in-memory cloud identity overrides at process startup.
 *
 * The identity overrides (the ID setters in `config/env.ts`) are normally
 * only populated at runtime when the platform pushes values. Any standalone
 * process that talks to the platform — the daemon and the schedule worker —
 * must rehydrate them before its first request.
 *
 * Bound ids come from `POST /v1/internal/assistants/validate/`, which trades
 * the assistant API key for assistant/organization/user ids. The base URL is
 * intentionally NOT rehydrated here: it resolves from `config.cloud.baseUrl`
 * or the `CADET_PLATFORM_URL` environment variable, never the credential
 * store.
 *
 * Safe to call more than once.
 */
import { getLogger } from "../util/logger.js";
import { ensureCloudIdentityIds } from "./cloud-identity.js";

const log = getLogger("cloud-rehydration");

/**
 * Rehydrate the cloud identity ids (assistant, organization, user). Safe to
 * call more than once.
 */
export async function rehydrateCloudCredentials(): Promise<void> {
  try {
    await ensureCloudIdentityIds();
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to rehydrate cloud identity ids (non-fatal)",
    );
  }
}
