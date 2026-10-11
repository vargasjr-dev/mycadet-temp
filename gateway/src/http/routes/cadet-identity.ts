/**
 * Cadet identity validation — cloud-managed email.
 *
 * The route's edge-scoped auth already authenticates the cloud,
 * so no external API key validation is needed.
 */

import { getLogger } from "../../logger.js";
import type { EmailValidationResult } from "./inbound-register.js";

const log = getLogger("cadet-identity");

export async function validateCadetEmail(
  _apiKey: string,
  guardianEmail: string,
): Promise<EmailValidationResult | null> {
  log.info("Platform-managed email — trusting provided guardian email");
  return {
    channel: "email",
    externalUserId: guardianEmail,
    deliveryChatId: guardianEmail,
    displayName: guardianEmail,
  };
}
