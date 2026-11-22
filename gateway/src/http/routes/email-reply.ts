/**
 * Plugin email reply surface — the gateway endpoints the runtime's email
 * tool calls for the BYO/plugin lane:
 *
 * - GET /email/messages — the merged surface's plugin rows (newest first).
 * - POST /email/reply   — thread a reply onto a stored message: the gateway
 *   resolves the parent row, sends through the SAME provider account the
 *   mail arrived on (the address she actually emailed), sets In-Reply-To /
 *   References, appends the quote tail, and records the outbound row.
 *
 * Auth is a capability token minted once and persisted in the gateway db.
 * The pipeline embeds it in the replyCallbackUrl it hands the runtime with
 * every forwarded email; the runtime presents it as a Bearer token. This
 * keeps an open mail-sending endpoint off the tunnel-exposed webhook
 * surface without any new pairing machinery.
 */

import { z } from "zod";

import { resolveCredentialWithRefresh } from "../../credential-refresh.js";
import { getCredentials } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import {
  ensureEmailReplyToken,
  getEmailMessageById,
  listEmailMessages,
  recordOutboundEmail,
  verifyEmailReplyToken,
} from "../../db/email-message-store.js";
import { buildQuotedHistory } from "../../email/quote.js";
import {
  sendMailgunReply,
  sendResendReply,
} from "../../email/reply-sender.js";
import { getLogger } from "../../logger.js";
import { readLimitedBody } from "../read-limited-body.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("email-reply-route");

/** Loopback — the gateway and the runtime share the VM. */
export function buildEmailReplyCallbackUrl(gatewayPort: number): string {
  return `http://127.0.0.1:${gatewayPort}/email/reply?token=${ensureEmailReplyToken()}`;
}

/** Same origin and token as the reply URL — the list rides them too. */
export function buildEmailMessagesUrl(gatewayPort: number): string {
  return `http://127.0.0.1:${gatewayPort}/email/messages?token=${ensureEmailReplyToken()}`;
}

function tokenFromRequest(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || null;
  }
  const url = new URL(req.url);
  return url.searchParams.get("token");
}

/** Custom auth strategy: the capability token IS the check. */
function isAuthorized(req: Request): boolean {
  return verifyEmailReplyToken(tokenFromRequest(req));
}

const replyBodySchema = z.object({
  /** The gateway email_messages row id to thread onto. */
  reply_to: z.number().int().positive(),
  text: z.string().min(1),
});

/** The RFC chain a reply carries: the parent's chain plus the parent's id. */
function buildReferencesChain(parent: {
  messageId: string | null;
  referencesChain: string | null;
}): string | null {
  return [parent.referencesChain, parent.messageId]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .trim() || null;
}

async function handleReply(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const bodyResult = await readLimitedBody(req, 1024 * 1024);
  if (bodyResult.status !== "ok") {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  const parsed = replyBodySchema.safeParse(
    JSON.parse(bodyResult.text || "{}"),
  );
  if (!parsed.success) {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }

  const parent = getEmailMessageById(parsed.data.reply_to);
  if (!parent) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (parent.direction !== "in" || !parent.messageId) {
    // Replies thread onto RECEIVED mail carrying a real Message-ID.
    return Response.json({ error: "Not replyable" }, { status: 409 });
  }

  let apiKey: string | undefined;
  try {
    apiKey =
      (await resolveCredentialWithRefresh(
        getCredentials(),
        credentialKey(parent.provider, "api_key"),
      )) ?? undefined;
  } catch (err) {
    log.error({ err, provider: parent.provider }, "Failed to resolve provider credential");
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
  if (!apiKey) {
    return Response.json(
      { error: "Provider credentials not configured" },
      { status: 503 },
    );
  }

  const references = buildReferencesChain(parent);
  const subject = `Re: ${parent.subject ?? "(no subject)"}`;
  const quote = buildQuotedHistory(
    {
      fromAddress: parent.fromAddr,
      createdAt: new Date(parent.createdAt),
    },
    { text: parent.bodyText, html: null },
  );
  const text = `${parsed.data.text}\n\n${quote.text}`;

  const replyInput = {
    from: parent.toAddr,
    to: parent.fromAddr,
    subject,
    text,
    inReplyTo: parent.messageId,
    references,
  };
  const providerMessageId =
    parent.provider === "resend"
      ? await sendResendReply(apiKey, replyInput)
      : parent.provider === "mailgun"
        ? await sendMailgunReply(apiKey, replyInput)
        : null;
  if (!providerMessageId) {
    return Response.json({ error: "Send failed" }, { status: 502 });
  }

  const row = recordOutboundEmail({
    assistantId: parent.assistantId,
    provider: parent.provider,
    messageId: providerMessageId,
    inReplyTo: parent.messageId,
    referencesChain: references,
    fromAddr: replyInput.from,
    toAddr: replyInput.to,
    subject,
    bodyText: text,
  });
  return Response.json({ ok: true, message: row });
}

function handleList(req: Request): Response {
  if (!isAuthorized(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(Math.trunc(limitParam), 1), 200)
    : 50;
  return Response.json({ ok: true, messages: listEmailMessages(limit) });
}

export const ROUTES: RouteDefinition[] = [
  {
    path: "/email/reply",
    method: "post",
    summary: "Send a threaded reply through the BYO email provider",
    description:
      "Resolves the stored plugin-lane message, sends a reply through the same provider account with In-Reply-To/References threading headers and a quoted tail, and records the outbound row. Capability-token auth.",
    auth: "custom",
    handler: handleReply,
  },
  {
    path: "/email/messages",
    method: "get",
    summary: "List the plugin email lane's history",
    description:
      "Newest-first rows of mail received through this gateway's BYO provider webhooks and replies the gateway sent. Capability-token auth.",
    auth: "custom",
    queryParameters: [
      { name: "limit", description: "Max rows (1-200, default 50)" },
    ],
    handler: handleList,
  },
];
