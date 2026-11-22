/**
 * Store for the plugin email lane: the mail this gateway's BYO provider
 * webhooks receive and the replies the gateway sends on the assistant's
 * behalf. The model's email surface reads this through the gateway's
 * /email/messages and replies through /email/reply — the plugin lane's own
 * history, distinct from Cadet Cloud Email's store.
 */

import { desc, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { getGatewayDb } from "./connection.js";
import { emailMessages, emailReplyTokens } from "./schema.js";

export interface EmailMessageRow {
  id: number;
  assistantId: string;
  direction: "in" | "out";
  provider: string;
  messageId: string | null;
  inReplyTo: string | null;
  referencesChain: string | null;
  fromAddr: string;
  toAddr: string;
  subject: string | null;
  bodyText: string | null;
  createdAt: number;
}

export interface RecordInboundEmailInput {
  assistantId: string;
  provider: string;
  messageId: string | null;
  inReplyTo: string | null;
  referencesChain: string | null;
  fromAddr: string;
  toAddr: string;
  subject: string | null;
  bodyText: string | null;
}

/**
 * Idempotent on Message-ID: a provider webhook retry redelivers the same
 * id, and the history must not grow a copy. Returns the row plus whether
 * THIS call inserted it (false = redelivery).
 */
export function recordInboundEmail(
  input: RecordInboundEmailInput,
): { row: EmailMessageRow; inserted: boolean } {
  const dbase = getGatewayDb();
  if (input.messageId) {
    const existing = dbase
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.messageId, input.messageId))
      .limit(1)
      .all();
    if (existing[0]) {
      return { row: existing[0], inserted: false };
    }
  }
  const result = dbase
    .insert(emailMessages)
    .values({
      assistantId: input.assistantId,
      direction: "in",
      provider: input.provider,
      messageId: input.messageId,
      inReplyTo: input.inReplyTo,
      referencesChain: input.referencesChain,
      fromAddr: input.fromAddr,
      toAddr: input.toAddr,
      subject: input.subject,
      bodyText: input.bodyText,
      createdAt: Date.now(),
    })
    .returning()
    .all();
  return { row: result[0], inserted: true };
}

export interface RecordOutboundEmailInput {
  assistantId: string;
  provider: string;
  messageId: string | null;
  inReplyTo: string | null;
  referencesChain: string | null;
  fromAddr: string;
  toAddr: string;
  subject: string;
  bodyText: string;
}

/** Records a reply the gateway sent, with the provider's message id. */
export function recordOutboundEmail(
  input: RecordOutboundEmailInput,
): EmailMessageRow {
  const dbase = getGatewayDb();
  const result = dbase
    .insert(emailMessages)
    .values({
      assistantId: input.assistantId,
      direction: "out",
      provider: input.provider,
      messageId: input.messageId,
      inReplyTo: input.inReplyTo,
      referencesChain: input.referencesChain,
      fromAddr: input.fromAddr,
      toAddr: input.toAddr,
      subject: input.subject,
      bodyText: input.bodyText,
      createdAt: Date.now(),
    })
    .returning()
    .all();
  return result[0];
}

export function getEmailMessageById(id: number): EmailMessageRow | null {
  const dbase = getGatewayDb();
  const rows = dbase
    .select()
    .from(emailMessages)
    .where(eq(emailMessages.id, id))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

export function listEmailMessages(limit: number): EmailMessageRow[] {
  const dbase = getGatewayDb();
  return dbase
    .select()
    .from(emailMessages)
    .orderBy(desc(emailMessages.createdAt))
    .limit(limit)
    .all();
}

/**
 * The capability token embedded in email reply callback URLs. Persisted so
 * a callback URL the runtime stored on an inbound event keeps working
 * across gateway restarts; minted once on first use.
 */
export function ensureEmailReplyToken(): string {
  const dbase = getGatewayDb();
  const rows = dbase
    .select()
    .from(emailReplyTokens)
    .where(eq(emailReplyTokens.id, 1))
    .limit(1)
    .all();
  if (rows[0]) {
    return rows[0].token;
  }
  const token = randomBytes(24).toString("base64url");
  dbase
    .insert(emailReplyTokens)
    .values({ id: 1, token })
    .onConflictDoNothing()
    .run();
  const minted = dbase
    .select()
    .from(emailReplyTokens)
    .where(eq(emailReplyTokens.id, 1))
    .limit(1)
    .all();
  return minted[0].token;
}

export function verifyEmailReplyToken(token: string | null): boolean {
  if (!token) {
    return false;
  }
  const dbase = getGatewayDb();
  const rows = dbase
    .select()
    .from(emailReplyTokens)
    .where(eq(emailReplyTokens.token, token))
    .limit(1)
    .all();
  return rows.length > 0;
}
