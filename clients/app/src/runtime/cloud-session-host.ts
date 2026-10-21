import { postLocalCommand } from "@app/runtime/local-host-transport";

/** The callback validates its nonce before handing the token to the host proxy. */
export async function registerLocalCloudSession(
  token: string,
): Promise<boolean> {
  const result = await postLocalCommand("/v1/session", {
    token,
  });
  return result.ok;
}
