import type { AssistantHosting } from "@/assistant/hosting";

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
  /** The active assistant's hosting: `resolving` is not yet an answer. */
  hosting: AssistantHosting;
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
 * resolving hosting read is `loading`, never `unavailable`: on a cold load
 * the assistant resolution has not answered yet, and reading "no hosted
 * assistant" into that would bounce a user whose resolution is on its way.
 */
export function resolveInboxStatus(inputs: InboxStatusInputs): InboxStatus {
  if (inputs.hosting === "resolving") {
    return "loading";
  }
  if (inputs.hosting !== "cloud") {
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
