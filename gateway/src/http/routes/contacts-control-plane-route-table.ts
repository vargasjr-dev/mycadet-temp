/**
 * Contact-family HTTP route table (flat paths only).
 *
 * Single source of truth for the contacts/contact-channels registrations in
 * `index.ts` — the runtime router AND the OpenAPI generation script consume
 * these declarations, so the tested routes cannot drift from production.
 *
 * Registration ORDER is load-bearing: the invites routes must precede the
 * `/v1/contacts/:id` catch-alls so `DELETE /v1/contacts/invites/:id` revokes
 * an invite instead of deleting a contact named "invites". The contacts
 * DELETE catch-all keeps its negative lookahead for the same reason.
 *
 * The five published operations carry their OpenAPI metadata inline; the
 * rest are dispatch-only. Handlers arrive as deps (the proxy is built from
 * config in index.ts), so the generation script calls this builder with
 * stub deps and reads only the metadata.
 */

import { RiskThresholdSchema } from "@mycadet/gateway-client";
import { z } from "zod";

import type { RouteDefinition } from "../router.js";
import type { GatewayRouteDefinition } from "./types.js";
import type {
  handleContactPromptSubmit,
  handleContactRecordSubmit,
} from "./contact-prompt.js";
import type { createContactsControlPlaneProxyHandler } from "./contacts-control-plane-proxy.js";

export type ContactsControlPlaneProxy = ReturnType<
  typeof createContactsControlPlaneProxyHandler
>;

export interface ContactsControlPlaneRouteDeps {
  contactsControlPlaneProxy: ContactsControlPlaneProxy;
  handleContactPromptSubmit: typeof handleContactPromptSubmit;
  handleContactRecordSubmit: typeof handleContactRecordSubmit;
}

// ---------------------------------------------------------------------------
// Wire shapes (matching toContactPayload / ContactStore rows)
// ---------------------------------------------------------------------------

const ContactChannelPayloadSchema = z.object({
  id: z.string(),
  contactId: z.string(),
  type: z.string(),
  address: z.string(),
  isPrimary: z.boolean(),
  externalChatId: z.string().nullable(),
  externalUserId: z
    .string()
    .describe("Compat alias for address, for older macOS clients"),
  status: z.string().nullable(),
  policy: z.string().nullable(),
  verifiedAt: z.number().nullable(),
  verifiedVia: z.string().nullable(),
  inviteId: z.string().nullable(),
  revokedReason: z.string().nullable(),
  blockedReason: z.string().nullable(),
  lastSeenAt: z.number().nullable(),
  interactionCount: z.number(),
  lastInteraction: z.number().nullable(),
  createdAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
});

const AssistantContactMetadataSchema = z.object({
  species: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

const ContactPayloadSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  role: z.string(),
  notes: z.string().nullable(),
  contactType: z.string().nullable(),
  principalId: z.string().nullable(),
  userFile: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  interactionCount: z.number(),
  lastInteraction: z.number().nullable(),
  autoApproveThreshold: RiskThresholdSchema.nullable().describe(
    "Per-contact auto-approve ceiling. Null means unset, inheriting the cascade.",
  ),
  assistantMetadata: AssistantContactMetadataSchema.nullable(),
  channels: z.array(ContactChannelPayloadSchema),
});

/** Gateway contact_channels row (no compat alias), returned by verify. */
const ContactChannelRowSchema = ContactChannelPayloadSchema.omit({
  externalUserId: true,
});

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

const UpsertContactChannelInputSchema = z.object({
  type: z.string(),
  address: z.string(),
  isPrimary: z.boolean().optional(),
  externalChatId: z
    .string()
    .optional()
    .describe(
      "Delivery chat id. Omit to preserve the stored value. A legacy explicit null is accepted for compatibility and treated as omitted; clearing is not supported: a stored null is indistinguishable from never-learned, so no consumer could tell a clear from a gap.",
    ),
  status: z.string().optional(),
  policy: z.string().optional(),
});

const UpsertContactRequestSchema = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "Existing contact id to update; omit to create or match by channel",
    ),
  displayName: z
    .string()
    .min(1)
    .describe("Required on every upsert, including updates by id"),
  notes: z.string().nullable().optional(),
  autoApproveThreshold: RiskThresholdSchema.nullable()
    .optional()
    .describe(
      "Per-contact auto-approve ceiling. Omit to preserve; null clears.",
    ),
  contactType: z.string().optional(),
  assistantMetadata: z
    .object({
      species: z.string(),
      metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .optional()
    .describe("Required when contactType is 'assistant'"),
  channels: z.array(UpsertContactChannelInputSchema).optional(),
});

const ContactPromptSubmitRequestSchema = z.object({
  requestId: z
    .string()
    .describe("The contact_request id broadcast by the assistant"),
  address: z.string().optional().describe("Required unless cancelled is true"),
  channelType: z
    .string()
    .optional()
    .describe("Required unless cancelled is true"),
  role: z.string().optional(),
  displayName: z.string().optional(),
  contactId: z
    .string()
    .optional()
    .describe(
      "The contact the parked form targets, echoed back from the broadcast. The parked form is authoritative.",
    ),
  verify: z
    .boolean()
    .optional()
    .describe(
      "The form's 'mark verified' checkbox as the guardian left it. Omit only from clients that predate the checkbox; the parked command's flag is then used instead.",
    ),
  cancelled: z
    .boolean()
    .optional()
    .describe(
      "The guardian dismissed the form. Unblocks the waiting command without writing.",
    ),
});

const ContactRecordSubmitRequestSchema = z.object({
  requestId: z
    .string()
    .describe("The contact_record_request id broadcast by the assistant"),
  operation: z
    .enum(["create", "update", "delete", "merge"])
    .optional()
    .describe("Required unless cancelled is true"),
  contactId: z
    .string()
    .optional()
    .describe("Required to update or delete, and the survivor of a merge"),
  donorContactId: z
    .string()
    .optional()
    .describe("The contact merged away. Required for a merge."),
  displayName: z.string().optional(),
  notes: z.string().nullable().optional(),
  expectedChannels: z
    .array(z.object({ type: z.string(), address: z.string() }))
    .optional()
    .describe(
      "The channels the delete confirmation listed. The delete is refused if the contact's channels changed since.",
    ),
  cancelled: z
    .boolean()
    .optional()
    .describe(
      "The guardian dismissed the form. Unblocks the waiting command without writing.",
    ),
});

export function buildContactsControlPlaneRoutes({
  contactsControlPlaneProxy,
  handleContactPromptSubmit,
  handleContactRecordSubmit,
}: ContactsControlPlaneRouteDeps): Array<
  GatewayRouteDefinition | RouteDefinition
> {
  return [
    {
      path: "/contacts/prompt/submit",
      method: "post",
      operationId: "contactsPromptSubmit",
      summary: "Submit a contact-prompt address",
      description:
        "Completes a contact_request the assistant broadcast: writes the contact and channel gateway-first, then unblocks the waiting prompt.",
      tags: ["contacts"],
      requestBody: ContactPromptSubmitRequestSchema,
      responseBody: z.object({
        accepted: z.boolean(),
        error: z.string().optional(),
        duplicate: z
          .boolean()
          .optional()
          .describe(
            "Another client answered this form first. Nothing is wrong, but none of this submission's values were written.",
          ),
      }),
      auth: "edge",
      createHandler: () => (req) => handleContactPromptSubmit(req),
    },
    {
      path: "/contacts/record/submit",
      method: "post",
      operationId: "contactsRecordSubmit",
      summary: "Submit a contact-record form",
      description:
        "Completes a contact_record_request the assistant broadcast: writes the record the guardian confirmed, then unblocks the waiting command. A create or update writes display name and notes, never a channel; a merge moves the donor's channels to the survivor and deletes the donor. A cancelled submission unblocks the command without writing.",
      tags: ["contacts"],
      requestBody: ContactRecordSubmitRequestSchema,
      responseBody: z.object({
        accepted: z.boolean(),
        error: z.string().optional(),
        duplicate: z
          .boolean()
          .optional()
          .describe(
            "Another client answered this form first. Nothing is wrong, but none of this submission's values were written.",
          ),
      }),
      auth: "edge",
      createHandler: () => (req) => handleContactRecordSubmit(req),
    },
    {
      path: "/contacts",
      method: "get",
      auth: "edge",
      createHandler: () => (req) => contactsControlPlaneProxy.handleListContacts(req),
    },
    {
      path: "/contacts",
      method: "post",
      operationId: "contactsUpsert",
      summary: "Create or update a contact",
      description:
        "Gateway-native contact upsert that dual-writes the gateway ACL store and the assistant info mirror. Matches by id, then by the provided type and address channel, else creates.",
      tags: ["contacts"],
      requestBody: UpsertContactRequestSchema,
      responseBody: z.object({
        ok: z.boolean(),
        contact: ContactPayloadSchema,
      }),
      auth: "edge",
      createHandler: () => (req) => contactsControlPlaneProxy.handleUpsertContact(req),
    },
    {
      path: "/contacts/merge",
      method: "post",
      auth: "edge",
      createHandler: () => (req) => contactsControlPlaneProxy.handleMergeContacts(req),
    },
    {
      path: "/contact-channels/{channel_id}",
      method: "patch",
      auth: "edge",
      createHandler: () => (req, params) =>
        contactsControlPlaneProxy.handleUpdateContactChannel(req, params[0]!),
    },
    {
      path: "/contact-channels/{channel_id}/verify",
      method: "post",
      operationId: "contactChannelVerify",
      summary: "Manually verify a contact channel",
      description:
        "Guardian-only manual attestation: marks the channel active/verified in the gateway store, the source of truth, with a best-effort assistant mirror. Idempotent.",
      tags: ["contacts"],
      pathParameters: [
        { name: "channel_id", description: "The contact-channel id" },
      ],
      responseBody: z.object({
        ok: z.boolean(),
        channel: ContactChannelRowSchema,
      }),
      auth: "edge-guardian",
      createHandler: () => (req, params) =>
        contactsControlPlaneProxy.handleVerifyContactChannel(req, params[0]!),
    },
    // ── Contacts/invites control plane ──
    // Scope map: invites list → settings.read; create/redeem/revoke/call →
    // settings.write.
    {
      path: "/contacts/invites",
      method: "get",
      auth: "edge-scoped",
      scope: "settings.read",
      createHandler: () => (req) => contactsControlPlaneProxy.handleListInvites(req),
    },
    {
      path: "/contacts/invites",
      method: "post",
      auth: "edge-scoped",
      scope: "settings.write",
      createHandler: () => (req) => contactsControlPlaneProxy.handleCreateInvite(req),
    },
    {
      path: "/contacts/invites/redeem",
      method: "post",
      auth: "edge-scoped",
      scope: "settings.write",
      createHandler: () => (req) => contactsControlPlaneProxy.handleRedeemInvite(req),
    },
    {
      path: "/contacts/invites/{invite_id}/call",
      method: "post",
      auth: "edge-scoped",
      scope: "settings.write",
      createHandler: () => (req, params) =>
        contactsControlPlaneProxy.handleCallInvite(req, params[0]!),
    },
    {
      path: "/contacts/invites/{invite_id}",
      method: "delete",
      auth: "edge-scoped",
      scope: "settings.write",
      createHandler: () => (req, params) =>
        contactsControlPlaneProxy.handleRevokeInvite(req, params[0]!),
    },
    // ── Contacts catch-alls — LAST: the invites routes above must win on
    // /contacts/invites/*. Raw regexes because the DELETE needs a negative
    // lookahead: DELETE on the invite collection stays unsupported (only
    // /contacts/invites/:id revokes an invite), which a {contact_id}
    // template cannot express. The published metadata (contactDelete)
    // travels on the entry regardless — the spec documents the canonical
    // /contacts/{contact_id} shape. ──
    {
      // Keep DELETE on the invite collection unsupported; only
      // /contacts/invites/:id should revoke an invite.
      path: /^\/contacts\/(?!invites\/?$)([^/]+)\/?$/,
      specPath: "/contacts/{contact_id}",
      method: "delete",
      operationId: "contactDelete",
      summary: "Delete a contact",
      description:
        "Deletes a non-guardian contact from the gateway ACL store and the assistant mirror. 404 when the contact exists in neither; 403 for guardian contacts.",
      tags: ["contacts"],
      pathParameters: [{ name: "contact_id", description: "The contact id" }],
      responseStatus: "204",
      auth: "edge",
      createHandler: () => (_req, params) =>
        contactsControlPlaneProxy.handleDeleteContact(params[0]!),
    },
    {
      path: /^\/contacts\/([^/]+)$/,
      method: "get",
      auth: "edge",
      createHandler: () => (req, params) =>
        contactsControlPlaneProxy.handleGetContact(req, params[0]!),
    },
  ];
}