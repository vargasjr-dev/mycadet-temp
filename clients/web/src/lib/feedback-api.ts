/**
 * The feedback submission's dial: a same-origin multipart POST to the
 * serving host's cloud proxy at `/v1/feedback/` — the browser's own
 * session cookie carries the call, the way every other web-bundle dial
 * works. Attachments and the diagnostics archive only travel as
 * multipart parts, so the body is a FormData the caller assembles with
 * {@link buildFeedbackForm}.
 *
 * The classification and client unions are restated here rather than
 * carried from a generated cloud spec: they are the cloud's documented
 * accept set, and this POST has no generated type to lean on.
 */

import { z } from "zod";

export type FeedbackClassification =
  | "bug_report"
  | "feature_request"
  | "other";

/**
 * Which client this feedback is being sent from — the cloud's accept set
 * for `client`. Restated from the platform's documented enum; a value the
 * cloud stops accepting surfaces as a rejected submission here.
 */
export type FeedbackClient =
  | "macos"
  | "ios"
  | "android"
  | "web"
  | "cli"
  | "electron";

export interface FeedbackSubmission {
  message: string;
  classification: FeedbackClassification;
  client: FeedbackClient;
  client_version?: string;
  assistant_id?: string;
  assistant_version?: string;
  doctor_session_id?: string;
  logs_file?: Blob | File;
  attachments?: Array<Blob | File>;
}

const FeedbackIngestResponseSchema = z.object({ id: z.string() });

/** The multipart form assembly: arrays fan out, blobs append raw. */
export function buildFeedbackForm(submission: FeedbackSubmission): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(submission)) {
    if (value == null) {
      continue;
    }
    if (key === "attachments" && Array.isArray(value)) {
      for (const file of value) {
        form.append("attachments", file as Blob);
      }
      continue;
    }
    if (value instanceof Blob) {
      form.append(key, value);
    } else {
      form.append(key, String(value));
    }
  }
  return form;
}

/**
 * POST the submission same-origin. A validation rejection (e.g. the
 * cloud refusing a native client value) throws the response's parsed
 * error body itself, so call sites can inspect the offending fields.
 */
const FEEDBACK_URL = "/v1/feedback/";

export async function submitFeedbackForm(
  form: FormData,
): Promise<{ id: string }> {
  const response = await fetch(FEEDBACK_URL, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    if (body !== null && typeof body === "object" && "client" in body) {
      throw body;
    }
    const detail =
      typeof (body as { detail?: unknown } | null)?.detail === "string"
        ? (body as { detail: string }).detail
        : `Failed to submit feedback (${response.status}).`;
    throw new Error(detail);
  }
  return FeedbackIngestResponseSchema.parse(await response.json());
}
