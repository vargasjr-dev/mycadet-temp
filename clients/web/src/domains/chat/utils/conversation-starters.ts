/** A single starter chip rendered under the composer — the app-editing
 * side panel's contextual chips. (Formerly the daemon-generated
 * conversation-starter chips; that endpoint and the empty-state bait
 * layer were removed outright.) */
export interface ConversationStarter {
  id: string;
  label: string;
  /** Sent verbatim as the first user message when the chip is clicked. */
  prompt: string;
  category?: string | null;
  batch?: number;
}
