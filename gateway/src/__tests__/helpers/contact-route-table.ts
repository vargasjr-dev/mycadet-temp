/**
 * Wires the REAL contact-family route table with marker handlers, so suites
 * can pin route matching and auth/scope against production registrations.
 * The handler modules are mocked (before the table import), then the table's
 * ROUTES are flattened through the router's own expansion. A route is
 * identified by invoking its handler and reading the `{ marker }` body.
 */
import { mock } from "bun:test";

import { expandRoute } from "../../http/router.js";
import "../test-preload.js";

const actualProxyModule = await import(
  "../../http/routes/contacts-control-plane-proxy.js"
);
const actualPromptModule = await import("../../http/routes/contact-prompt.js");

const marker = (name: string) => async () => Response.json({ marker: name });

const markerProxy = {
  handleListContacts: marker("handleListContacts"),
  handleUpsertContact: marker("handleUpsertContact"),
  handleGetContact: marker("handleGetContact"),
  handleDeleteContact: marker("handleDeleteContact"),
  handleMergeContacts: marker("handleMergeContacts"),
  handleUpdateContactChannel: marker("handleUpdateContactChannel"),
  handleVerifyContactChannel: marker("handleVerifyContactChannel"),
  handleListInvites: marker("handleListInvites"),
  handleCreateInvite: marker("handleCreateInvite"),
  handleRedeemInvite: marker("handleRedeemInvite"),
  handleCallInvite: marker("handleCallInvite"),
  handleRevokeInvite: marker("handleRevokeInvite"),
};

mock.module("../../http/routes/contacts-control-plane-proxy.js", () => ({
  ...actualProxyModule,
  createContactsControlPlaneProxyHandler: () => markerProxy,
}));
mock.module("../../http/routes/contact-prompt.js", () => ({
  ...actualPromptModule,
  handleContactPromptSubmit: marker("handleContactPromptSubmit"),
  handleContactRecordSubmit: marker("handleContactRecordSubmit"),
}));

const { ROUTES: contactRoutes } = await import(
  "../../http/routes/contacts-control-plane-route-table.js"
);

type FlatContactRoute = ReturnType<typeof expandRoute>[number];

export function buildMarkedContactRoutes(): FlatContactRoute[] {
  return contactRoutes.flatMap(expandRoute);
}

/** Resolves which proxy binding a marked route's handler is bound to. */
export async function markedHandlerName(
  route: FlatContactRoute,
): Promise<string> {
  const res = await route.handler(
    new Request("http://gateway.local/"),
    ["p0"],
    () => "127.0.0.1",
    () => "127.0.0.1",
  );
  const body = (await res.json()) as { marker?: string };
  if (!body.marker) {
    throw new Error(`route handler returned no marker: ${JSON.stringify(body)}`);
  }
  return body.marker;
}
