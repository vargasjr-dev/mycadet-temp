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
  organizationId?: string;
  signal: AbortSignal;
}

export async function resolveAssistant({
  apiBaseUrl = "/",
  origin,
  assistantId,
  organizationId,
  signal,
}: AssistantRequest): Promise<AssistantResolution> {
  const base = new URL(decode(PublicUrlSchema, apiBaseUrl), origin);
  base.pathname = base.pathname.replace(/\/*$/, "/");
  const headers = new Headers({ Accept: "application/json" });
  if (organizationId) {
    headers.set("Cadet-Organization-Id", organizationId);
  }
  const unauthenticated = Symbol("unauthenticated");
  async function get(path: string) {
    signal.throwIfAborted();
    const response = await fetch(new URL(path, base), {
      headers,
      signal,
      credentials: "include",
    });
    if (response.status === 401) {
      return unauthenticated;
    }
    if (!response.ok) {
      throw new Error(`Assistant request failed: ${response.status}`);
    }
    const payload: unknown = await response.json();
    signal.throwIfAborted();
    return payload;
  }
  if (!assistantId) {
    const assistants: z.infer<typeof AssistantChoiceSchema>[] = [];
    for (let page = 0; page < 20; page++) {
      const payload = await get(
        `v1/assistants/?limit=100&offset=${assistants.length}`,
      );
      if (payload === unauthenticated) {
        return { status: "unauthenticated" };
      }
      const data = decode(PageSchema, payload);
      assistants.push(...data.results);
      if (!data.next) {
        if (assistants.length === 0) {
          return { status: "empty" };
        }
        if (assistants.length > 1) {
          return { status: "selection", assistants };
        }
        assistantId = assistants[0].id;
        break;
      }
      if (data.results.length === 0 || page === 19) {
        throw new Error("Assistant list exceeded its page limit.");
      }
    }
  }
  if (!assistantId || [".", ".."].includes(assistantId)) {
    throw new Error("Invalid assistant identity.");
  }
  const payload = await get(
    `v1/assistants/${encodeURIComponent(assistantId)}/`,
  );
  if (payload === unauthenticated) {
    return { status: "unauthenticated" };
  }
  const detail = decode(AssistantDetailSchema, payload);
  if (detail.id !== assistantId) {
    throw new Error("Assistant identity does not match the request.");
  }
  if (["archived", "archiving", "to_be_deleted"].includes(detail.status)) {
    return { status: "unavailable" };
  }
  if (detail.status !== "active" || !detail.ui || !detail.runtime) {
    return { status: "starting" };
  }
  return {
    status: "ready",
    assistant: {
      id: detail.id,
      ui: { ...detail.ui, entryUrl: new URL(detail.ui.entryUrl, base).href },
      runtime: { baseUrl: new URL(detail.runtime.baseUrl, base).href },
    },
  };
}
