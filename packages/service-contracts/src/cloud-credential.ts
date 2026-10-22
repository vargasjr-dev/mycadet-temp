/**
 * Wire contract for asking an assistant whether its stored cloud-managed
 * credential still authenticates.
 *
 * The daemon route is the authoritative serving side:
 *   - `POST /v1/cloud/verify-credential`
 *       (`assistant/src/runtime/routes/cloud-routes.ts`)
 *
 * The daemon's platform client produces the verdict, the route reports it,
 * and the `cadet` CLI reads it before deciding whether a stored key can be
 * re-injected (`cli/src/lib/assistant-api-key-resolution.ts`), so all three
 * share one definition and cannot silently drift. The web app reads the same
 * shape through its generated daemon client.
 */
import { z } from "zod";

/**
 * What the cloud said about the stored credential, right now.
 *
 *   - `valid`: the cloud accepted it.
 *   - `rejected`: the cloud refused it (unauthorized or forbidden); the
 *     credential needs replacing.
 *   - `unknown`: the check itself could not run (no credential stored, the
 *     platform unreachable, a server error). Not evidence either way.
 */
export const CloudCredentialVerificationStatusSchema = z.enum([
  "valid",
  "rejected",
  "unknown",
]);
export type CloudCredentialVerificationStatus = z.infer<
  typeof CloudCredentialVerificationStatusSchema
>;

/** `POST /v1/cloud/verify-credential` response body. */
export const CloudVerifyCredentialResponseSchema = z.object({
  status: CloudCredentialVerificationStatusSchema,
});
export type CloudVerifyCredentialResponse = z.infer<
  typeof CloudVerifyCredentialResponseSchema
>;
