import {
  buildMcpOAuthCallbackUrl,
  buildMcpOAuthClientMetadata,
  buildMcpOAuthClientMetadataUrl,
} from "@mycadet/service-contracts/mcp-oauth";
import { normalizeHttpPublicBaseUrlWithoutTrailingSlash } from "@mycadet/service-contracts/ingress";

import { getConfigFileCache } from "../../config-file-cache.js";

/** The `/oauth/client-metadata.json` document. Reads the config-file cache
 * singleton at request time — no factory, no injection. */
export function handleMcpOAuthClientMetadata(): Response {
  const configFile = getConfigFileCache();
  const ingressEnabled = configFile.getBoolean("ingress", "enabled", {
    force: true,
  });
  const publicBaseUrl = normalizeHttpPublicBaseUrlWithoutTrailingSlash(
    configFile.getString("ingress", "publicBaseUrl", { force: true }),
  );

  if (
    ingressEnabled === false ||
    !publicBaseUrl ||
    new URL(publicBaseUrl).protocol !== "https:"
  ) {
    return Response.json(
      { error: "MCP OAuth client metadata is unavailable" },
      { status: 503 },
    );
  }

  return Response.json(
    buildMcpOAuthClientMetadata({
      clientId: buildMcpOAuthClientMetadataUrl(publicBaseUrl),
      redirectUris: [buildMcpOAuthCallbackUrl(publicBaseUrl)],
    }),
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
