import { z } from "zod";

/**
 * The teleport signed-url dial rides the operator api's host-served row
 * (`POST /v1/assistants/{id}/migrations/signed-url/`): the hop to the
 * cloud happens on the operator's own credentials, so the browser never
 * needs a cloud session to export a backup.
 */
export async function requestSignedDownloadUrl(
  assistantId: string,
  bundleKey: string,
  _runtimeVersion: string | undefined,
  downloadFilename?: string,
): Promise<string> {
  // eslint-disable-next-line no-restricted-syntax -- the operator row is host-served (same-origin cookies carry the session) and has no generated cloud-sdk type to dial through.
  const response = await fetch(
    `/v1/assistants/${encodeURIComponent(assistantId)}/migrations/signed-url/`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "download",
        bundle_key: bundleKey,
        download_filename: downloadFilename,
      }),
    },
  );
  if (!response.ok) {
    const detail = await response
      .json()
      .then((body) => (body as { detail?: unknown }).detail)
      .catch(() => null);
    throw new Error(
      typeof detail === "string"
        ? detail
        : `The signed-url dial failed (${response.status})`,
    );
  }
  return z.object({ url: z.string().url() }).parse(await response.json()).url;
}
