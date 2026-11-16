import {
  chmodSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "fs";
import { dirname } from "path";

import {
  cloudAuthHeaders,
  cloudTokenPath,
  loopbackSafeFetch,
} from "@mycadet/local-mode";
import { getCloudBaseUrl } from "@mycadet/shared";
import { z } from "zod";

export function saveCloudToken(token: string): void {
  const tokenPath = cloudTokenPath();
  const dir = dirname(tokenPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
}

export function clearCloudToken(): void {
  try {
    unlinkSync(cloudTokenPath());
  } catch {
    // already doesn't exist
  }
}

export interface HatchedAssistant {
  id: string;
  name: string;
  status: string;
}

// The operator contract's list union (local-mode runListRoute): every row
// the account owns as a choice, or the empty arm. The list's rows are
// usable choices — readiness verdicts come from the scoped dial, not the
// list — so each listed row reads back as active.
const AssistantListUnionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("empty") }),
  z.object({
    status: z.literal("selection"),
    assistants: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
]);

// The chooser's list body: rows are usable choices — a non-union body (or
// the empty arm) is a non-fatal empty list.
function decodeAssistantList(body: unknown): HatchedAssistant[] {
  const union = AssistantListUnionSchema.safeParse(body);
  if (!union.success) return [];
  return union.data.status === "selection"
    ? union.data.assistants.map((row) => ({
        id: row.id,
        name: row.name,
        status: "active",
      }))
    : [];
}

const CLOUD_FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch the authenticated user's cloud assistants — the operator contract's
 * list union (local-mode runListRoute). Returns an empty array on failure
 * (non-fatal).
 */
export async function fetchCloudAssistants(
  token: string,
): Promise<HatchedAssistant[]> {
  const resolvedUrl = getCloudBaseUrl();
  const url = `${resolvedUrl}/v1/assistants/`;

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    CLOUD_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await loopbackSafeFetch(url, {
      signal: controller.signal,
      headers: await cloudAuthHeaders(token),
    });

    if (!response.ok) return [];

    return decodeAssistantList(await response.json().catch(() => null));
  } finally {
    clearTimeout(timeoutId);
  }
}
