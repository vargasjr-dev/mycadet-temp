/**
 * The doctor panel's operator-api client: the panel dials the OPERATOR
 * surface's UNSCOPED spelling (`/v1/assistant/doctor/...`) — the host
 * resolves the active assistant from its lockfile, because the Doctor is
 * an ACCOUNT surface: it doctors what is on this machine, independent of
 * any assistant selection riding a router state. The serving host mounts
 * the operator rows in-process, so the panel keeps working when the
 * entry's gateway is completely offline — the doctor's main use case.
 * The operator rows proxy verbatim to the cloud on the operator's own
 * credentials.
 *
 * Responses are validated with the panel's own schemas at this boundary —
 * the operator api has no generated spec to type them.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Response schemas — the cloud shapes the panel reads
// ---------------------------------------------------------------------------

export const DoctorMessageSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "user",
    "assistant",
    "tool_call",
    "tool_result",
    "approval",
    "status",
    "error",
  ]),
  content: z.string(),
  metadata: z.unknown(),
  sequence: z.number(),
  source_event_id: z.string().nullable(),
  occurred_at: z.string(),
});

const DoctorHistoryListSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      last_message_at: z.string().nullable(),
      created: z.string(),
    }),
  ),
});

const DoctorHistorySessionSchema = z.object({
  status: z.enum(["active", "completed", "error"]),
  messages: z.array(DoctorMessageSchema),
  user_outcome: z.string().nullable(),
});

const DoctorSessionSchema = z.object({ session_id: z.string() });

export type DoctorHistoryListResult = z.infer<typeof DoctorHistoryListSchema>;
export type DoctorHistorySessionResult = z.infer<
  typeof DoctorHistorySessionSchema
>;

// ---------------------------------------------------------------------------
// Dial helpers — hey-api-shaped results so the panel's call sites barely move
// ---------------------------------------------------------------------------

type OperatorResult<T> = {
  data: T | null;
  error: { detail: string } | null;
  response: Response;
};

async function dial(
  path: string,
  init?: RequestInit,
): Promise<OperatorResult<unknown>> {
  const response = await fetch(path, init);
  let detail: string | null = null;
  if (!response.ok) {
    try {
      const body = (await response.json()) as { detail?: unknown };
      detail = typeof body.detail === "string" ? body.detail : null;
    } catch {
      detail = null;
    }
  }
  const data = response.ok
    ? await response.json().catch(() => null)
    : null;
  return { data, error: detail === null ? null : { detail }, response };
}

/** The operator api's paginated doctor history for the active assistant. */
export async function doctorHistoryList(args: {
  query?: { limit?: string };
}): Promise<OperatorResult<DoctorHistoryListResult>> {
  const search = args.query?.limit
    ? `?limit=${encodeURIComponent(args.query.limit)}`
    : "";
  const result = await dial(`/v1/assistant/doctor/history/${search}`);
  const parsed = DoctorHistoryListSchema.safeParse(result.data);
  return {
    ...result,
    data: parsed.success ? parsed.data : null,
  };
}

/** One persisted doctor session with its messages. */
export async function doctorHistoryRetrieve(args: {
  path: { doctor_session_id: string };
}): Promise<OperatorResult<DoctorHistorySessionResult>> {
  const result = await dial(
    `/v1/assistant/doctor/history/${encodeURIComponent(args.path.doctor_session_id)}/`,
  );
  const parsed = DoctorHistorySessionSchema.safeParse(result.data);
  return {
    ...result,
    data: parsed.success ? parsed.data : null,
  };
}

/** Start a doctor session; answers the session record. */
export async function doctorSessionsCreate(args?: {
  path?: Record<string, never>;
}): Promise<OperatorResult<z.infer<typeof DoctorSessionSchema>>> {
  const result = await dial("/v1/assistant/doctor/sessions/", {
    method: "POST",
  });
  const parsed = DoctorSessionSchema.safeParse(result.data);
  return {
    ...result,
    data: parsed.success ? parsed.data : null,
  };
}

/** End a doctor session. */
export async function doctorSessionsDestroy(args: {
  path: { session_id: string };
}): Promise<OperatorResult<null>> {
  const result = await dial(
    `/v1/assistant/doctor/sessions/${encodeURIComponent(args.path.session_id)}/`,
    { method: "DELETE" },
  );
  return { ...result, data: null };
}

/** Post the guardian's message into the session. */
export async function doctorSessionsMessagesCreate(args: {
  path: { session_id: string };
  body: { content: string; source_event_id?: string | null };
}): Promise<OperatorResult<unknown>> {
  return dial(
    `/v1/assistant/doctor/sessions/${encodeURIComponent(args.path.session_id)}/messages/`,
    { method: "POST", body: JSON.stringify(args.body) },
  );
}

/** Record the guardian's outcome answer. */
export async function doctorSessionsUserOutcomeCreate(args: {
  path: { session_id: string };
  body: { resolved: boolean };
}): Promise<OperatorResult<unknown>> {
  return dial(
    `/v1/assistant/doctor/sessions/${encodeURIComponent(args.path.session_id)}/user-outcome/`,
    { method: "POST", body: JSON.stringify(args.body) },
  );
}
