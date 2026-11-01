/**
 * Channel inbound routes: message ingress, conversation deletion,
 * and background message processing.
 *
 * Implementation is split across:
 * - inbound-conversation.ts      — conversation deletion
 * - inbound-message-handler.ts   — main inbound handler with background processing
 */
