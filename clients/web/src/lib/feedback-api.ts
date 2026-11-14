/**
 * The feedback submission's dial: a multipart POST straight to the cloud's
 * ingest route at `{cloud}/v1/feedback/` — the one deliberate exception to
 * the bundle's same-origin rule, because the daemon's cloud proxy forward
 * is gone and feedback belongs to the cloud whatever host serves the page.
 * The browser's cloud session cookie rides on the call (credentials:
 * "include" covers both the cloud-hosted same-origin case and a
 * self-hosted page posting across to the cloud). Attachments and the
 * diagnostics archive only travel as multipart parts, so the body is a
 * FormData the caller assembles with {@link buildFeedbackForm}.
 *
 * The classification and client unions are restated here rather than
 * carried from a generated cloud spec: they are the cloud's documented
 * accept set, and this POST has no generated type to lean on.
 */

import { z } from "zod";

import { getCloudBaseUrl } from "@mycadet/shared";

import { dial } from "@/lib/dial";

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
 * POST the submission straight to the cloud. A validation rejection
 * (e.g. the cloud refusing a native client value) throws the response's
 * parsed error body itself, so call sites can inspect the offending
 * fields.
 */
const feedbackUrl = () => `${getCloudBaseUrl()}/v1/feedback/`;

export async function submitFeedbackForm(
  form: FormData,
): Promise<{ id: string }> {
  const { response, data } = await dial(feedbackUrl(), {
    method: "POST",
    body: form,
    credentials: "include",
  });
  if (!response?.ok) {
    if (data !== null && typeof data === "object" && "client" in data) {
      throw data;
    }
    const detail =
      typeof (data as { detail?: unknown } | null)?.detail === "string"
        ? (data as { detail: string }).detail
        : `Failed to submit feedback (${response?.status}).`;
    throw new Error(detail);
  }
  return FeedbackIngestResponseSchema.parse(data);
}
