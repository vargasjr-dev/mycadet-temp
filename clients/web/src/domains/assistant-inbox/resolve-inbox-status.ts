/**
 * What the Assistant Inbox shows for this assistant.
 *
 * - `unavailable`: no managed mailbox for this assistant (not
 *   cloud-hosted). Nothing to draw and no rail entry. Composed by the
 *   hook, not by {@link resolveInboxStatus} — email inboxes for
 *   non-cloud assistants are planned, so the pure decision does not
 *   read hosting.
 * - `loading`: the reads that decide have not settled.
 * - `setup`: the assistant has no address yet.
 * - `ready`: an address exists; the mailbox can be shown.
 */
export type InboxStatus = "unavailable" | "loading" | "setup" | "ready";

export interface InboxStatusInputs {
  /** The platform id the assistant routes key on; `null` while unresolved. */
  cloudAssistantId: string | null;
  /** `undefined` until the address list has been read once. */
  addressCount: number | undefined;
  /**
   * The domain list has answered, with rows or an error. Setup decides what
   * to register from it, so setup is not offered until it has.
   */
  domainsSettled: boolean;
}

/** Pure so the decision can be tested without the hooks that feed it. */
export function resolveInboxStatus(inputs: InboxStatusInputs): InboxStatus {
  if (!inputs.cloudAssistantId || inputs.addressCount === undefined) {
    return "loading";
  }
  if (inputs.addressCount > 0) {
    return "ready";
  }
  return inputs.domainsSettled ? "setup" : "loading";
}
