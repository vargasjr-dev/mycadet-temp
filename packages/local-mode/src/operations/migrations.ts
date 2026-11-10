/**
 * The teleport OPERATOR row: the signed-url dial the web bundle's backup
 * export makes when it hands a bundle over the cloud. The web used to
 * dial the cloud's `/v1/migrations/signed-url/` directly on its own
 * session; now the host serves the row and hops on the OPERATOR's own
 * credentials (the doctor rows' pattern), so the browser never needs a
 * cloud session for teleport.
 *
 * The cloud's dial is not assistant-addressed — the bundle key carries
 * the association — so the lockfile entry only contributes the
 * organization header, and the body passes through verbatim.
 */

import { loopbackSafeFetch } from "../loopback-fetch";
import { findAssistantByName } from "./lookup";
import type { OperatorRequest } from "./routes";
import {
  UPSTREAM_TIMEOUT_MS,
  cloudOrigin,
  operatorCloudHeaders,
  operatorError,
  readOperatorCloudToken,
} from "./cloud-proxy";

export async function runMigrationsSignedUrlRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const entry = findAssistantByName(request.assistantId);
  if (!entry) {
    return null;
  }
  const token = readOperatorCloudToken();
  if (!token) {
    return operatorError(
      "Not logged in to Cadet Cloud, so the backup export is unavailable.",
      401,
    );
  }

  try {
    return await loopbackSafeFetch(
      `${cloudOrigin()}/v1/migrations/signed-url/`,
      {
        method: "POST",
        headers: operatorCloudHeaders(entry, token),
        body: request.body
          ? await new Response(request.body).text()
          : undefined,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
  } catch (err) {
    console.warn(
      "[migrations] cloud dial failed (signed-url):",
      err instanceof Error ? err.message : err,
    );
    return operatorError(
      "Could not reach Cadet Cloud for the backup export.",
      502,
    );
  }
}
