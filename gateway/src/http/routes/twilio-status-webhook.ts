import { getConfig } from "../../config.js";
import { getConfigFileCache } from "../../config-file-cache.js";
import { getCredentials } from "../../credential-cache.js";
import { getLogger } from "../../logger.js";
import {
  CircuitBreakerOpenError,
  forwardTwilioStatusWebhook,
} from "../../runtime/client.js";
import { validateTwilioWebhookRequest } from "../../twilio/validate-webhook.js";

const log = getLogger("twilio-status-webhook");

/** The `/webhooks/twilio/status` provider callback. Reads the config and
 * validation-caches singletons at request time — no factory, no injection. */
export async function handleTwilioStatusWebhook(
  req: Request,
): Promise<Response> {
  const config = getConfig();
  const caches = {
    credentials: getCredentials(),
    configFile: getConfigFileCache(),
  };
  const validation = await validateTwilioWebhookRequest(req, config, caches);
  if (validation instanceof Response) return validation;

  const { params } = validation;
  log.info(
    { callSid: params.CallSid, callStatus: params.CallStatus },
    "Twilio status webhook received",
  );

  try {
    const runtimeResponse = await forwardTwilioStatusWebhook(config, params);
    return new Response(runtimeResponse.body, {
      status: runtimeResponse.status,
      headers: runtimeResponse.headers,
    });
  } catch (err) {
    if (err instanceof CircuitBreakerOpenError) {
      return Response.json(
        { error: "Service temporarily unavailable" },
        {
          status: 503,
          headers: { "Retry-After": String(err.retryAfterSecs) },
        },
      );
    }
    log.error({ err }, "Failed to forward Twilio status webhook to runtime");
    return Response.json({ error: "Internal server error" }, { status: 502 });
  }
}
