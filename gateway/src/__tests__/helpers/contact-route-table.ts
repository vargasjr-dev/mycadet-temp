/**
 * Wires the REAL contact-family route table with marker handlers, so suites
 * can pin route matching and auth/scope against production registrations.
 * The contacts module's static ROUTES array is initialized with a marked
 * proxy, then flattened through the router's own expansion. A route is
 * identified by invoking its handler and reading the `{ marker }` body.
 */
import { expandRoute } from "../../http/router.js";
import {
  initContactsControlPlaneRoutes,
  ROUTES as contactRoutes,
  type ContactsControlPlaneProxy,
} from "../../http/routes/contacts-control-plane-route-table.js";

type FlatContactRoute = ReturnType<typeof expandRoute>[number];

const marker = (name: string) => async () => Response.json({ marker: name });

export function buildMarkedContactRoutes(): FlatContactRoute[] {
  const contactsControlPlaneProxy: ContactsControlPlaneProxy = {
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
  initContactsControlPlaneRoutes({
    contactsControlPlaneProxy,
    handleContactPromptSubmit: marker("handleContactPromptSubmit"),
    handleContactRecordSubmit: marker("handleContactRecordSubmit"),
  });
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
  return ((await res.json()) as { marker: string }).marker;
}
