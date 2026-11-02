import { z } from "zod";

import {
  AssistantResolutionSchema,
  PublicUrlSchema,
  type AssistantResolution,
} from "./resolution-contract";

function decode<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new Error("Invalid assistant API data.");
  }
  return result.data;
}

export interface AssistantRequest {
  apiBaseUrl?: string;
  assistantId?: string;
  signal: AbortSignal;
}

const unauthenticated = Symbol("unauthenticated");
const notReady = Symbol("not ready");
const unavailable = Symbol("unavailable");

function createClient({ apiBaseUrl = "/", signal }: AssistantRequest) {
  // The shell is same-origin by construction — every host (the desktop
  // protocol, the web dev server, the cloud takeover) proxies the API at
  // the page's own origin. Read inside: SSR renders the shell without a
  // window, and the origin is a browser fact.
  const origin = window.location.origin;
  const base = new URL(decode(PublicUrlSchema, apiBaseUrl), origin);
  base.pathname = base.pathname.replace(/\/*$/, "/");
  const headers = new Headers({ Accept: "application/json" });
  async function get(path: string) {
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
    if (response.status === 409) {
      return notReady;
    }
    if (response.status === 410) {
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

/**
 * The shell's resolution: ONE call to the same-origin assistant resolution
 * endpoint — the serving host's operation composes the whole union (the
 * lockfile's choice, the entry gateway's identity and the caller's own auth
 * verdict) and the client just decodes it. The status-code arms stay for
 * hosts whose operation forwards a platform detail's own codes, and for
 * older stacks whose baked metadata predates the union.
 */
export async function resolveAssistant(
  options: AssistantRequest,
): Promise<AssistantResolution> {
  const client = createClient(options);
  const payload = await client.get(
    options.assistantId
      ? `v1/assistants/${encodeURIComponent(options.assistantId)}/`
      : "v1/assistant",
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
      url: new URL(parsed.assistant.url, client.base).href,
    },
  };
}
