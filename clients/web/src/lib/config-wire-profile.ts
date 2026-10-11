import type { ProfileEntryOutput } from "@/generated/daemon/types.gen";

/**
 * The wire view of a profile entry: the persisted schema plus the wire-only
 * flags the daemon stamps onto config responses — `invariant` (a managed
 * cloud-profile stub) and `supportsVision` (resolved from the model
 * catalog). The flags are deliberately absent from the persisted schema — a
 * config write's schema parse strips echoed copies instead of persisting
 * them — so they don't ride the generated type; the wire view widens it
 * where the UI consumes them.
 */
export type WireProfileEntry = ProfileEntryOutput & {
  invariant?: boolean;
  supportsVision?: boolean;
};

/** The `llm.profiles` map as the config response serves it. */
export type WireProfilesMap = Record<string, WireProfileEntry>;
