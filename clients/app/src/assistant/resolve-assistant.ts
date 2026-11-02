import { z } from "zod";

import {
  AssistantChoiceSchema,
  AssistantResolutionSchema,
  PublicUrlSchema,
  type AssistantResolution,
} from "./resolution-contract";

const PageSchema = z.object({
  results: z.array(AssistantChoiceSchema),
  next: z.string().nullable().optional(),
});
function decode<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new Error("Invalid assistant API data.");
  }
  return result.data;
}

export interface AssistantRequest {
  apiBaseUrl?: string;
  origin: string;
  signal: AbortSignal;
}

const unauthenticated = Symbol("unauthenticated");
const notReady = Symbol("not ready");
const unavailable = Symbol("unavailable");

function createClient({ apiBaseUrl = "/", origin, signal }: AssistantRequest) {
  const base = new URL(decode(PublicUrlSchema, apiBaseUrl), origin);
  base.pathname = base.pathname.replace(/\/*$/, "/");
  const headers = new Headers({ Accept: "application/json" });
  async function get(path: string, detail = false) {
    signal.throwIfAborted();
    const requestUrl = new URL(path, base);
    const response = await fetch(requestUrl, {
      headers,
      signal,
      credentials: "include",
    });
    signal.throwIfAborted();
    if (response.status === 401) {
      return unauthenticated;
    }
    if (detail && response.status === 409) {
      return notReady;
    }
    if (detail && response.status === 410) {
      return unavailable;
    }
    if (!response.ok) {
      console.error(
        `Assistant request failed: ${response.status} ${response.headers.get("content-type") ?? ""} from ${requestUrl.href}`,
      );
      throw new Error(
        `Assistant request failed: ${response.status} from ${requestUrl.href}`,
      );
    }
    const payload: unknown = await response.json().catch((error) => {
      console.error(
        `Assistant response was not JSON from ${requestUrl.href}: ${error}`,
      );
      throw error;
    });
    signal.throwIfAborted();
    return payload;
  }
  return { base, get };
}

type AssistantList = Extract<
  AssistantResolution,
  { status: "selection" | "unauthenticated" }
>;

async function listChoices(
  client: ReturnType<typeof createClient>,
): Promise<AssistantList> {
  const assistants: z.infer<typeof AssistantChoiceSchema>[] = [];
  for (let page = 0; page < 20; page++) {
    const payload = await client.get(
      `v1/assistants/?limit=100&offset=${assistants.length}`,
    );
    if (payload === unauthenticated) {
      return { status: "unauthenticated" };
    }
    const data = decode(PageSchema, payload);
    assistants.push(...data.results);
    if (!data.next) {
      return { status: "selection", assistants };
    }
    if (data.results.length === 0 || page === 19) {
      throw new Error("Assistant list exceeded its page limit.");
    }
  }
  throw new Error("Assistant list exceeded its page limit.");
}

export async function listAssistantChoices(
  options: Omit<AssistantRequest, "assistantId">,
): Promise<AssistantList> {
  return listChoices(createClient(options));
}

/**
 * The shell's resolution: ONE call to the same-origin `GET /v1/assistant`
 * operation. The serving host composes the whole union — the lockfile's
 * choice, the entry gateway's identity and the caller's own auth verdict —
 * so the client just decodes it. The status-code arms (401/409/410) stay
 * for hosts whose operation forwards a platform detail's own codes, and for
 * older stacks whose baked metadata predates the union.
 */
export async function resolveAssistant(
  options: AssistantRequest,
): Promise<AssistantResolution> {
  const base = new URL(
    decode(PublicUrlSchema, options.apiBaseUrl ?? "/"),
    options.origin,
  );
  base.pathname = base.pathname.replace(/\/*$/, "/");
  options.signal.throwIfAborted();
  const requestUrl = new URL("v1/assistant", base);
  const response = await fetch(requestUrl, {
    headers: new Headers({ Accept: "application/json" }),
    signal: options.signal,
    credentials: "include",
  });
  options.signal.throwIfAborted();
  if (response.status === 401) {
    return { status: "unauthenticated" };
  }
  if (response.status === 409) {
    return { status: "notReady" };
  }
  if (response.status === 410) {
    return { status: "unavailable" };
  }
  if (!response.ok) {
    console.error(
      `Assistant request failed: ${response.status} ${response.headers.get("content-type") ?? ""} from ${requestUrl.href}`,
    );
    throw new Error(
      `Assistant request failed: ${response.status} from ${requestUrl.href}`,
    );
  }
  const payload: unknown = await response.json().catch((error) => {
    console.error(
      `Assistant response was not JSON from ${requestUrl.href}: ${error}`,
    );
    throw error;
  });
  options.signal.throwIfAborted();
  const parsed = decode(AssistantResolutionSchema, payload);
  if (parsed.status !== "ready") {
    return parsed;
  }
  return {
    status: "ready",
    assistant: {
      // The endpoint answers the host-relative entry; absolute against the
      // API base, so a paired apiBase's own origin wins over the shell's.
      ...parsed.assistant,
      url: new URL(parsed.assistant.url, base).href,
    },
  };
}
