/**
 * Route handlers for the email management API.
 *
 * Delegates to the Cadet Cloud API for register/unregister/send/list/status/download.
 * All handlers require a valid platform client (UnauthorizedError if not).
 */

import { z } from "zod";

import { stringParam } from "../../util/wire-params.js";

/**
 * The cloud email API's wire shapes: responses parse at the boundary (a
 * malformed payload fails the route loudly) and the error body is a
 * fail-soft probe since only `detail` is read.
 */
const errorBodyProbe = z
  .object({ detail: z.unknown().optional() })
  .loose()
  .catch({ detail: undefined });
const registerResponseProbe = z.object({
  id: z.string(),
  address: z.string(),
  created_at: z.string(),
});
const statusResponseProbe = z.object({
  address: z.string(),
  status: z.string(),
  created_at: z.string(),
  usage: z.object({
    sent_today: z.number(),
    daily_limit: z.number(),
    received_today: z.number(),
    sent_this_month: z.number(),
    received_this_month: z.number(),
  }),
});
const listResponseProbe = z.object({
  results: z.array(z.unknown()),
  count: z.number(),
});
const attachmentMetaSchema = z.object({
  message_id: z.string(),
  filename: z.string(),
  content_type: z.string(),
  size: z.number().optional(),
});
const attachmentListProbe = z
  .object({ results: z.array(attachmentMetaSchema).optional().catch([]) })
  .transform((d) => ({ results: d.results ?? [] }));

const sendResponseProbe = z.object({
  delivery_id: z.string(),
  status: z.string(),
});
const sendBodyProbe = z.object({
  to: z.array(z.string()).catch([]),
  text: z.string().catch(""),
  subject: z.string().optional().catch(undefined),
  html: z.string().optional().catch(undefined),
  cc: z.array(z.string()).optional().catch(undefined),
  bcc: z.array(z.string()).optional().catch(undefined),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        content_type: z.string(),
        content: z.string(),
      }),
    )
    .optional()
    .catch(undefined),
  reply_to: z.string().optional().catch(undefined),
});

import { CadetCloudClient } from "../../cloud/client.js";
import { getReadinessService } from "../../daemon/handlers/config-channels.js";
import { markdownToEmailHtml } from "../../email/html-renderer.js";
import {
  invalidateRegisteredInboxCache,
  listEmailAddresses,
  type RegisteredEmailAddress,
} from "../../email/registered-inbox.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import {
  BadRequestError,
  NotFoundError,
  RouteError,
  UnauthorizedError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────

async function requireClient(): Promise<CadetCloudClient> {
  const client = await CadetCloudClient.create();
  if (!client) {
    throw new UnauthorizedError(
      "Platform credentials not configured. Run: assistant cloud connect",
    );
  }
  if (!client.cloudAssistantId) {
    throw new UnauthorizedError(
      "Assistant ID not configured. Run: assistant cloud connect",
    );
  }
  return client;
}

// ── Handlers ──────────────────────────────────────────────────────────

async function handleEmailRegister({ body = {} }: RouteHandlerArgs) {
  const username = stringParam(body.username) ?? "";
  const client = await requireClient();

  const response = await client.fetch(
    `/v1/assistants/${client.cloudAssistantId}/email-addresses/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    },
  );

  if (!response.ok) {
    const respBody = errorBodyProbe.parse(
      await response.json().catch(() => ({})),
    );
    const detail =
      respBody.detail ??
      (Array.isArray(respBody.username) ? respBody.username[0] : undefined) ??
      (Array.isArray(respBody.assistant_id)
        ? respBody.assistant_id[0]
        : undefined) ??
      `HTTP ${response.status}`;
    throw new BadRequestError(String(detail));
  }

  const data = registerResponseProbe.parse(await response.json());
  invalidateEmailReadinessState();
  return data;
}

/**
 * A registration change must be visible on the next readiness read: both the
 * registered-inbox cache and the readiness service's cached email snapshot
 * would otherwise keep answering with the pre-change state for their TTL.
 */
function invalidateEmailReadinessState(): void {
  invalidateRegisteredInboxCache();
  getReadinessService().invalidateChannel("email");
}

/**
 * The registered addresses, or the route-appropriate error: a listing
 * failure maps to LIST_FAILED with the cloud's status when it sent one.
 */
async function requireEmailAddressList(
  client: CadetCloudClient,
): Promise<RegisteredEmailAddress[]> {
  const list = await listEmailAddresses(client);
  if (!list.ok) {
    throw new RouteError(
      `Failed to list email addresses: ${list.detail}`,
      "LIST_FAILED",
      list.status ?? 502,
    );
  }
  return list.addresses;
}

async function handleEmailUnregister(_args: RouteHandlerArgs) {
  const client = await requireClient();

  const addresses = await requireEmailAddressList(client);
  if (addresses.length === 0) {
    throw new NotFoundError("No email address registered for this assistant.");
  }

  const target = addresses[0];

  const deleteResponse = await client.fetch(
    `/v1/assistants/${client.cloudAssistantId}/email-addresses/${target.id}/`,
    { method: "DELETE" },
  );

  if (!deleteResponse.ok) {
    const respBody = errorBodyProbe.parse(
      await deleteResponse.json().catch(() => ({})),
    );
    const detail = respBody.detail ?? `HTTP ${deleteResponse.status}`;
    throw new RouteError(
      String(detail),
      "DELETE_FAILED",
      deleteResponse.status,
    );
  }

  invalidateEmailReadinessState();
  return { unregistered: target.address };
}

async function handleEmailStatus(_args: RouteHandlerArgs) {
  const client = await requireClient();

  const addresses = await requireEmailAddressList(client);
  if (addresses.length === 0) {
    throw new NotFoundError(
      "No email address registered for this assistant. Run: assistant email register <username>",
    );
  }

  const target = addresses[0];

  const statusResponse = await client.fetch(
    `/v1/assistants/${client.cloudAssistantId}/email-addresses/${target.id}/status/`,
  );

  if (!statusResponse.ok) {
    const respBody = errorBodyProbe.parse(
      await statusResponse.json().catch(() => ({})),
    );
    const detail = respBody.detail ?? `HTTP ${statusResponse.status}`;
    throw new RouteError(
      String(detail),
      "STATUS_FAILED",
      statusResponse.status,
    );
  }

  return statusResponseProbe.parse(await statusResponse.json());
}

async function handleEmailList({ queryParams = {} }: RouteHandlerArgs) {
  const client = await requireClient();

  const params = new URLSearchParams();
  if (queryParams.direction && queryParams.direction !== "all") {
    params.set("direction", queryParams.direction);
  }
  if (queryParams.limit) {
    params.set("limit", queryParams.limit);
  }
  if (queryParams.since) {
    params.set("since", queryParams.since);
  }

  const qs = params.toString();
  const path = `/v1/assistants/${client.cloudAssistantId}/emails/${qs ? `?${qs}` : ""}`;
  const response = await client.fetch(path);

  if (!response.ok) {
    const respBody = errorBodyProbe.parse(
      await response.json().catch(() => ({})),
    );
    const detail = respBody.detail ?? `HTTP ${response.status}`;
    throw new RouteError(String(detail), "LIST_FAILED", response.status);
  }

  const data = listResponseProbe.parse(await response.json());
  return { results: data.results, count: data.count };
}

async function handleEmailDownload({ queryParams = {} }: RouteHandlerArgs) {
  const client = await requireClient();
  const { messageId } = queryParams;

  const response = await client.fetch(
    `/v1/assistants/${client.cloudAssistantId}/emails/${messageId}/`,
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new NotFoundError(`Email message not found: ${messageId}`);
    }
    const respBody = errorBodyProbe.parse(
      await response.json().catch(() => ({})),
    );
    const detail = respBody.detail ?? `HTTP ${response.status}`;
    throw new RouteError(String(detail), "DOWNLOAD_FAILED", response.status);
  }

  return response.json();
}

async function handleEmailSend({ body = {} }: RouteHandlerArgs) {
  const send = sendBodyProbe.parse(body);
  const { to, text } = send;
  const subject = send.subject;
  const html = send.html;
  const cc = send.cc;
  const bcc = send.bcc;
  const attachments = send.attachments;
  const reply_to = send.reply_to;

  const client = await requireClient();

  // Resolve "from" address
  const addresses = await requireEmailAddressList(client);
  if (addresses.length === 0) {
    throw new NotFoundError(
      "No email address registered for this assistant. Run: assistant email register <username>",
    );
  }

  const fromAddress = addresses[0].address;

  // LLMs often produce literal "\n" escape sequences instead of real newlines.
  const normalizedText = text?.replace(/\\n/g, "\n") ?? "";

  // Auto-generate HTML from text if not provided
  const resolvedHtml = html ?? markdownToEmailHtml(normalizedText);

  const payload: Record<string, unknown> = {
    to,
    from_address: fromAddress,
    text: normalizedText,
  };
  if (subject) {
    payload.subject = subject;
  }
  if (resolvedHtml) {
    payload.html = resolvedHtml;
  }
  if (cc && cc.length > 0) {
    payload.cc = cc;
  }
  if (bcc && bcc.length > 0) {
    payload.bcc = bcc;
  }
  if (attachments && attachments.length > 0) {
    payload.attachments = attachments;
  }
  if (reply_to) {
    payload.reply_to = reply_to;
  }

  const response = await client.fetch("/v1/runtime-proxy/email/send/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    if (response.status === 402) {
      throw new RouteError(
        "Insufficient balance to send email. Add credits at https://cloud.mycadet.ai/billing",
        "PAYMENT_REQUIRED",
        402,
      );
    }
    const respBody = errorBodyProbe.parse(
      await response.json().catch(() => ({})),
    );
    const detail = respBody.detail ?? `HTTP ${response.status}`;
    throw new BadRequestError(String(detail));
  }

  return sendResponseProbe.parse(await response.json());
}

// ── Attachment handlers ───────────────────────────────────────────────

async function handleEmailAttachmentList({
  queryParams = {},
}: RouteHandlerArgs) {
  const client = await requireClient();
  const { messageId } = queryParams;

  const response = await client.fetch(
    `/v1/assistants/${client.cloudAssistantId}/emails/${messageId}/attachments/`,
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new NotFoundError(`Email message not found: ${messageId}`);
    }
    const respBody = errorBodyProbe.parse(
      await response.json().catch(() => ({})),
    );
    const detail = respBody.detail ?? `HTTP ${response.status}`;
    throw new RouteError(String(detail), "LIST_FAILED", response.status);
  }

  const data = attachmentListProbe.parse(await response.json());
  return data;
}

async function handleEmailAttachmentGet({
  queryParams = {},
}: RouteHandlerArgs) {
  const client = await requireClient();
  const { messageId, attachmentId } = queryParams;

  const response = await client.fetch(
    `/v1/assistants/${client.cloudAssistantId}/emails/${messageId}/attachments/${attachmentId}/download/`,
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new NotFoundError(`Attachment not found: ${attachmentId}`);
    }
    const respBody = errorBodyProbe.parse(
      await response.json().catch(() => ({})),
    );
    const detail = respBody.detail ?? `HTTP ${response.status}`;
    throw new RouteError(String(detail), "DOWNLOAD_FAILED", response.status);
  }

  if (!response.body) {
    throw new RouteError(
      "Empty response body from download endpoint.",
      "EMPTY_BODY",
      502,
    );
  }

  // Extract filename from content-disposition header, falling back to attachmentId
  const contentDisposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = contentDisposition.match(
    /filename\*?=['"]?([^'";]+)['"]?/i,
  );
  const filename = filenameMatch?.[1]?.trim() ?? attachmentId;

  const contentType =
    response.headers.get("content-type") ?? "application/octet-stream";

  // Return a streaming response — the IPC server pipes the ReadableStream as
  // chunked binary frames to the client
  return {
    stream: response.body,
    headers: {
      "content-type": contentType,
      "transfer-encoding": "chunked",
      "x-filename": filename,
    },
  };
}

// ── Routes ────────────────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "email_register",
    endpoint: "email/register",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEmailRegister,
    summary: "Register an email address",
    description:
      "Register a new email address on Cadet Cloud for the current assistant.",
    tags: ["email"],
    requestBody: z.object({
      username: z
        .string()
        .min(1)
        .describe("The local part of the email address"),
    }),
    responseBody: z.object({
      id: z.string(),
      address: z.string(),
      created_at: z.string(),
    }),
  },
  {
    operationId: "email_unregister",
    endpoint: "email/unregister",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEmailUnregister,
    summary: "Unregister the email address",
    description:
      "Remove the email address currently registered for this assistant.",
    tags: ["email"],
    responseBody: z.object({
      unregistered: z.string(),
    }),
  },
  {
    operationId: "email_status",
    endpoint: "email/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEmailStatus,
    summary: "Get email address status and usage",
    description:
      "Show the email address registered for this assistant along with current usage and quota information.",
    tags: ["email"],
    responseBody: z.object({
      address: z.string(),
      status: z.string(),
      created_at: z.string(),
      usage: z.object({
        sent_today: z.number(),
        daily_limit: z.number(),
        received_today: z.number(),
        sent_this_month: z.number(),
        received_this_month: z.number(),
      }),
    }),
  },
  {
    operationId: "email_list",
    endpoint: "email/list",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEmailList,
    summary: "List email messages",
    description:
      "List received and sent emails for this assistant, with optional filtering.",
    tags: ["email"],
    queryParams: [
      {
        name: "direction",
        type: "string",
        required: false,
        description: "Filter by direction: inbound, outbound, or all",
      },
      {
        name: "limit",
        type: "string",
        required: false,
        description: "Maximum number of results",
      },
      {
        name: "since",
        type: "string",
        required: false,
        description: "Only show messages since this date (ISO 8601)",
      },
    ],
    responseBody: z.object({
      results: z.array(z.unknown()),
      count: z.number(),
    }),
  },
  {
    operationId: "email_download",
    endpoint: "email/download",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEmailDownload,
    summary: "Download a specific email message",
    description: "Download a specific email message by ID.",
    tags: ["email"],
    queryParams: [
      {
        name: "messageId",
        type: "string",
        required: true,
        description: "Email message ID",
      },
    ],
    responseBody: z.unknown(),
  },
  {
    operationId: "email_send",
    endpoint: "email/send",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEmailSend,
    summary: "Send an email",
    description:
      "Send an email from the assistant's registered email address via the Cadet runtime proxy.",
    tags: ["email"],
    requestBody: z.object({
      to: z.array(z.string()).min(1).describe("Recipient email address(es)"),
      text: z.string().min(1).describe("Email body (plain text)"),
      subject: z.string().optional().describe("Subject line"),
      html: z
        .string()
        .optional()
        .describe("HTML body (auto-generated from text if omitted)"),
      cc: z.array(z.string()).optional().describe("CC recipients"),
      bcc: z.array(z.string()).optional().describe("BCC recipients"),
      attachments: z
        .array(
          z.object({
            filename: z.string(),
            content_type: z.string(),
            content: z.string().describe("Base64-encoded file content"),
          }),
        )
        .optional()
        .describe("File attachments"),
      reply_to: z.string().optional().describe("Reply-to email ID"),
    }),
    responseBody: z.object({
      delivery_id: z.string(),
      status: z.string(),
    }),
  },
  {
    operationId: "email_attachment_list",
    endpoint: "email/attachment-list",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEmailAttachmentList,
    summary: "List attachments for an email message",
    description:
      "Return attachment metadata (id, filename, content_type, size_bytes, content_id, created_at) for all attachments on a given email message.",
    tags: ["email"],
    queryParams: [
      {
        name: "messageId",
        type: "string",
        required: true,
        description: "Email message ID",
      },
    ],
    responseBody: z.object({
      results: z.array(
        z.object({
          id: z.string(),
          filename: z.string(),
          content_type: z.string(),
          size_bytes: z.number(),
          content_id: z.string(),
          created_at: z.string(),
        }),
      ),
    }),
  },
  {
    operationId: "email_attachment_get",
    endpoint: "email/attachment-get",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEmailAttachmentGet,
    summary: "Stream-download an email attachment",
    description:
      "Download the binary content of a specific email attachment as a chunked stream. Response headers include content-type from the upstream and x-filename derived from content-disposition.",
    tags: ["email"],
    queryParams: [
      {
        name: "messageId",
        type: "string",
        required: true,
        description: "Email message ID",
      },
      {
        name: "attachmentId",
        type: "string",
        required: true,
        description: "Attachment ID",
      },
    ],
  },
];
