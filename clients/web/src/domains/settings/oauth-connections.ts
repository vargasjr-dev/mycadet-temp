/**
 * The assistant's connected integration accounts, read at the bundle's
 * scoped assistant path — the gateway is the plane that eventually hits
 * the assistant, which will configure its own connections provider the
 * way it configures inference. The generated cloud sdk used to own the
 * transport and the type; both live here now, parsed at the boundary.
 */

import { z } from "zod";
import { useQuery } from "@tanstack/react-query";

const OAuthProviderSchema = z.string();

const ConnectionStatusSchema = z.enum(["ACTIVE", "REVOKED", "ERROR"]);

export const OAuthConnectionSchema = z.object({
  id: z.string(),
  provider: OAuthProviderSchema,
  status: ConnectionStatusSchema,
  connected: z.boolean(),
  account_label: z.string().nullable(),
  scopes_granted: z.array(z.string()),
  expires_at: z.string().nullable(),
  provider_params: z.record(z.string(), z.string()).optional(),
});
export type OAuthConnection = z.infer<typeof OAuthConnectionSchema>;

async function fetchList(path: string): Promise<OAuthConnection[]> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`The connections dial failed (${response.status})`);
  }
  const body = z
    .object({ results: z.array(OAuthConnectionSchema) })
    .parse(await response.json());
  return body.results;
}

/** The connections read's query keys, so invalidations stay honest. */
export const oauthKeys = {
  connections: (assistantId: string) => ["oauth-connections", assistantId],
};

export function useOauthConnectionsQuery(assistantId: string) {
  return useQuery({
    queryKey: oauthKeys.connections(assistantId),
    enabled: !!assistantId,
    queryFn: () =>
      fetchList(
        `/v1/assistants/${encodeURIComponent(assistantId)}/oauth/connections/`,
      ),
  });
}
