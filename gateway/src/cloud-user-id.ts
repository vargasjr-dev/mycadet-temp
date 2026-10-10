/**
 * Bound platform owner id for managed-mode edge auth.
 *
 * Identity is resolved from platform validate and in-memory last-known
 * values. See {@link readStoredCloudUserId} in `cloud-identity.ts`.
 */

export {
  _resetLastKnownPlatformUserIdForTest,
  readStoredCloudUserId,
  type StoredCloudUserId,
} from "./cloud-identity.js";
