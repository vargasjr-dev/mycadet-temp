import { pingGatewayHealth } from "@mycadet/local-mode";
import { z } from "zod";

import {
  AssistantChoiceSchema,
  AssistantDetailSchema,
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
  assistantId?: string;
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

export async function resolveAssistant(
  options: AssistantRequest,
): Promise<AssistantResolution> {
  const { base, get } = createClient(options);
  // The gateway health check is the identity ping: its auth verdict is the
  // one reliable signal the shell has before mounting the assistant's UI —
  // the /v1 routes can respond 200 without authentication — and its version
  // stamp is the version of record (replacing the cliPkg-stamped build
  // resolution). A server that does not answer the fields gives no verdict
  // and no version; the flow degrades to the detail payload's.
  const health = await pingGatewayHealth(base.href, {
    signal: options.signal,
  });
  if (!health.authenticated) {
    return { status: "unauthenticated" };
  }
  let assistantId = options.assistantId;
  if (!assistantId) {
    const result = await listChoices({ base, get });
    if (result.status === "unauthenticated") {
      return result;
    }
    if (result.assistants.length === 0) {
      return { status: "empty" };
    }
    if (result.assistants.length > 1) {
      return result;
    }
    assistantId = result.assistants[0].id;
  }
  if (!assistantId || [".", ".."].includes(assistantId)) {
    throw new Error("Invalid assistant identity.");
  }
  const payload = await get(
    `v1/assistants/${encodeURIComponent(assistantId)}/`,
    true,
  );
  if (payload === unauthenticated) {
    return { status: "unauthenticated" };
  }
  if (payload === notReady) {
    return { status: "notReady" };
  }
  if (payload === unavailable) {
    return { status: "unavailable" };
  }
  const detail = decode(AssistantDetailSchema, payload);
  if (detail.id !== assistantId) {
    throw new Error("Assistant identity does not match the request.");
  }
  return {
    status: "ready",
    assistant: {
      id: detail.id,
      version: health.version ?? detail.version,
      url: new URL(detail.url, base).href,
    },
  };
}
