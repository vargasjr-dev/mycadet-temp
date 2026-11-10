/**
 * The assistant's public-identity surface — the handle claim, its
 * availability probe, and the assistant's domains — proxied to the
 * platform.
 *
 * The assistant's public handle is a PLATFORM identity (one global
 * namespace), so the write can never be local: the gateway hops to the
 * platform on the assistant's own credentials (the shared
 * {@link forwardToPlatform}) and answers the platform's response
 * verbatim. The web bundle's handle surface dials these arms through the
 * assistant's gateway client instead of holding a cloud client.
 */

import { z } from "zod";

import { forwardToPlatform } from "./cloud-hop.js";
import type { RouteDefinition } from "./types.js";

const HandleAvailableSchema = z.object({
  available: z.boolean(),
  code: z.string().nullable(),
  message: z.string().nullable(),
});

// The platform's Assistant record, answered verbatim — the handle is the
// field this surface edits; the rest of the record passes through.
const AssistantRecordSchema = z.object({
  handle: z.string(),
}).passthrough();

// The platform's paginated domain list — the handle section reads the
// registered subdomain and its verification status.
const DomainListSchema = z.object({
  results: z.array(
    z.object({
      subdomain: z.string(),
      status: z.string(),
    }).passthrough(),
  ),
}).passthrough();

export const ROUTES: RouteDefinition[] = [
  {
    path: "/handle-available",
    method: "get",
    operationId: "handleAvailableRetrieve",
    summary: "Check assistant handle availability",
    description:
      "A platform-namespace check, proxied on the assistant's own " +
      "credentials. The candidate handle is lowercased before the check.",
    tags: ["settings"],
    queryParameters: [{ name: "handle", description: "The candidate handle" }],
    responseBody: HandleAvailableSchema,
    auth: "edge-scoped",
    scope: "settings.read",
    scoped: true,
    handler: (req) => forwardToPlatform(req, "/handle-available/"),
  },
  {
    path: "/handle",
    method: "patch",
    operationId: "handlePartialUpdate",
    summary: "Claim the assistant's public handle",
    description:
      "A platform write, proxied on the assistant's own credentials. " +
      "Failures come back as DRF field errors ({handle: [{code, string}]}).",
    tags: ["settings"],
    requestBody: z
      .object({
        handle: z.string(),
      })
      .strict(),
    responseBody: AssistantRecordSchema,
    auth: "edge-scoped",
    scope: "settings.write",
    scoped: true,
    handler: (req) => forwardToPlatform(req, "/"),
  },
  {
    path: "/domains",
    method: "get",
    operationId: "domainsList",
    summary: "List the assistant's domains",
    description:
      "The platform's domain registrations for this assistant, proxied on " +
      "its own credentials — the registered subdomain holds the handle.",
    tags: ["settings"],
    responseBody: DomainListSchema,
    auth: "edge-scoped",
    scope: "settings.read",
    scoped: true,
    handler: (req) => forwardToPlatform(req, "/domains/"),
  },
];
