import { verifyCadetSignature } from "../http/cadet-signature.js";

/**
 * Verify the Cadet-Signature header sent by Cadet Cloud.
 *
 * The scheme itself lives in `http/cadet-signature.ts`, shared with the
 * plugin webhook routes so one comparison serves both.
 */
export function verifyEmailWebhookSignature(
  headers: Headers,
  rawBody: string,
  webhookSecret: string,
): boolean {
  return verifyCadetSignature(headers, rawBody, webhookSecret);
}
