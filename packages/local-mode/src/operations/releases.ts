import {
  cloudOrigin,
  operatorError,
  readOperatorCloudToken,
} from "./cloud-proxy";
import type { OperatorRequest } from "./routes";

/**
 * The releases row: `GET /v1/releases` — the shell's upgrade shelf's
 * catalog read, host-served so the desktop's `app://` renderer can fetch
 * it same-origin. The dial is the cloud's own endpoint on the operator's
 * bearer token (the doctor rows' precedent for the `/v1` cloud API — the
 * browser flow's session-cookie spelling never leaves the cloud bundle).
 * The answer passes through verbatim: the catalog is the cloud's to
 * shape, caching headers included.
 */
export async function runReleasesRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const token = readOperatorCloudToken();
  if (!token) {
    return operatorError(
      "Not logged in to Cadet Cloud, so releases are unavailable.",
      401,
    );
  }
  try {
    const upstream = await fetch(`${cloudOrigin()}${request.path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  } catch (err) {
    return operatorError((err as Error).message, 502);
  }
}
