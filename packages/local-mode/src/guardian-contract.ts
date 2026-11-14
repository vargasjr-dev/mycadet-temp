/**
 * The guardian credential contract — one Zod schema that is the single
 * source of truth for the credential's shape on the wire and at rest:
 * the gateway's pairing mint and device-bound refresh both answer with
 * it, the lease parses with it, and the token file persists it.
 *
 * Kept in its own module, exported from the package as
 * `./guardian-contract`, so the CLI can import the contract without
 * pulling in the host I/O graph. It references no node built-ins and
 * `zod` is its only import.
 *
 * MIRRORED in `gateway/src/guardian-contract.ts` (same names, same
 * shape): the gateway can't depend on this package because local-mode
 * carries operator-facing APIs the gateway must never see. The
 * duplication is temporary — once the gateway client-generation
 * workstream lands, the generated SDK types replace both hand-rolled
 * copies. Delete the leftovers then.
 */
import { z } from "zod";

export const GuardianTokenFileSchema = z.object({
  guardianPrincipalId: z.string(),
  accessToken: z.string(),
  /** ISO date string or epoch-ms number as returned by the gateway. */
  accessTokenExpiresAt: z.union([z.string(), z.number()]),
  refreshToken: z.string(),
  /** ISO date string or epoch-ms number as returned by the gateway. */
  refreshTokenExpiresAt: z.union([z.string(), z.number()]),
  refreshAfter: z.string(),
  /** The paired device's id, echoed by the gateway so the binding persists. */
  deviceId: z.string(),
  /** ISO-8601 instant the credential was leased or rotated. */
  leasedAt: z.string(),
});

export interface GuardianTokenData extends z.infer<
  typeof GuardianTokenFileSchema
> {}
