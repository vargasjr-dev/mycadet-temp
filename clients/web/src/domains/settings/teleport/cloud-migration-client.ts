import { z } from "zod";
import { client } from "@/generated/api/client.gen";

export async function requestSignedDownloadUrl(
  bundleKey: string,
  _runtimeVersion: string | undefined,
  downloadFilename?: string,
): Promise<string> {
  const { data } = await client.post<unknown, unknown, true>({
    url: "/v1/migrations/signed-url/",
    body: {
      operation: "download",
      bundle_key: bundleKey,
      download_filename: downloadFilename,
    },
    throwOnError: true,
  });
  return z.object({ url: z.string().url() }).parse(data).url;
}
