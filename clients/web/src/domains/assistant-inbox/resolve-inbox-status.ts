import type { CloudGateStateWithPending } from "@/hooks/use-cloud-gate";

/**
 * What the Assistant Inbox shows for this assistant.
 *
 * - `unavailable`: no platform to ask (local mode, self-hosted assistant,
 *   or no session). Nothing to draw and no rail entry.
 * - `loading`: the reads that decide have not settled.
 * - `setup`: the assistant has no address yet.
 * - `ready`: an address exists; the mailbox can be shown.
 */
export type InboxStatus = "unavailable" | "loading" | "setup" | "ready";

export interface InboxStatusInputs {
  /** The pending-aware gate: `pending` is not yet an answer. */
  gate: CloudGateStateWithPending;
  /** The cloud assistant id resolved, or `null` while it has not. */
  cloudAssistantId: string | null;
  /** `undefined` until the address list has been read once. */
  addressCount: number | undefined;
  /**
   * The domain list has answered, with rows or an error. Setup decides what
   * to register from it, so setup is not offered until it has.
   */
  domainsSettled: boolean;
}

/**
 * Pure so the decision can be tested without the hooks that feed it. A
 * pending platform gate is `loading`, never `unavailable`: on a cold load
 * the session has not answered yet, and reading "no session" into that
 * would bounce a signed-in user.
 */
export function resolveInboxStatus(inputs: InboxStatusInputs): InboxStatus {
  if (inputs.gate === "pending") {
    return "loading";
  }
  if (inputs.gate !== "full") {
    return "unavailable";
  }
  if (!inputs.cloudAssistantId || inputs.addressCount === undefined) {
    return "loading";
  }
  if (inputs.addressCount > 0) {
    return "ready";
  }
  return inputs.domainsSettled ? "setup" : "loading";
}
