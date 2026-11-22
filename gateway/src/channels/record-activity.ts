import { resolveCloudAssistantIdOrUndefined } from "../cloud-identity.js";
import { getCloudBaseUrl } from "../cloud-url.js";
import { getCredentials } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";

const log = getLogger("record-activity");

/** Fire-and-forget: notify the cloud of inbound channel activity so the
 *  idle-sleep timer is reset for this assistant.
 *  Throttled to at most one outbound POST per 30 seconds, shared across
 *  channels so a busy stretch of mentions still pings the cloud at most
 *  twice a minute. */
let lastRecordActivityTs = 0;
export async function notifyRecordActivity(): Promise<void> {
  const now = Date.now();
  if (now - lastRecordActivityTs < 30_000) return;
  lastRecordActivityTs = now;

  try {
    const [assistantApiKey, assistantId] = await Promise.all([
      getCredentials().get(credentialKey("cadet", "assistant_api_key")),
      resolveCloudAssistantIdOrUndefined(),
    ]);
    const cloudBaseUrl = getCloudBaseUrl();

    if (!cloudBaseUrl || !assistantApiKey || !assistantId) return;

    const res = await fetchImpl(
      `${cloudBaseUrl}/v1/assistants/${assistantId}/record-activity/`,
      {
        method: "POST",
        headers: { Authorization: `Api-Key ${assistantApiKey.trim()}` },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      log.warn(
        { status: res.status },
        "Non-OK response from record-activity endpoint",
      );
    }
  } catch (err) {
    log.debug(
      { err },
      "Failed to notify platform of channel activity for idle sleep",
    );
  }
}
