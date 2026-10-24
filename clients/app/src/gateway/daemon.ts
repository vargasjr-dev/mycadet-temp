import { z } from "zod";

import {
  getCloud,
  postCloud,
  postCloudEmpty,
  type CloudResult,
} from "@app/lib/cloud/request";
import { resolveOrganization } from "@app/lib/cloud/organization";
import type {
  ConversationsPostResponses,
  MessagesGetResponses,
  MessagesPostData,
  PluginsSearchGetResponses,
  WorkspaceFileGetResponses,
} from "@web/generated/daemon/types.gen";

/**
 * The app-side gateway client for the scoped daemon namespace the onboarding
 * research machinery talks to (`/v1/assistants/{assistant_id}/...`). This is
 * the app twin of web's generated daemon SDK calls — the renderer invokes the
 * SAME relative `/v1` surface in ONE way (the single-origin rule) and the
 * serving host (the Electron `app://` protocol handler, the cloud's runtime
 * proxy) resolves the id to the assistant's gateway, so the renderer never
 * encodes a host or port.
 *
 * Wire shapes stay web-canonical via type-only imports of the generated
 * daemon types — no generated SDK client runs app-side. Responses validate
 * loosely on purpose: every caller in the onboarding machinery is best-effort
 * (a failed read yields an empty fallback, never a flow error) and the daemon
 * owns the wire contract, so `z.custom` passthroughs keep the parser honest
 * without re-declaring the daemon's schemas client-side.
 */

export type GatewayPluginMatch =
  PluginsSearchGetResponses[200]["matches"][number];

const ConversationsPostSchema = z.custom<
  ConversationsPostResponses[200]
>();

const MessagesGetSchema = z.custom<MessagesGetResponses[200]>();

const PluginsSearchSchema = z.custom<PluginsSearchGetResponses[200]>();

const WorkspaceFileSchema = z.custom<WorkspaceFileGetResponses[200]>();

/** Body for a background research conversation. */
export interface CreateConversationBody {
  conversationType: string;
  title?: string;
}

/** Mint a conversation under the assistant's workspace. */
export function createAssistantConversation(
  assistantId: string,
  body: CreateConversationBody,
): Promise<CloudResult<ConversationsPostResponses[200]>> {
  return scoped(assistantId, (path, org) =>
    postCloud(path("conversations"), ConversationsPostSchema, body, {
      organizationId: org,
    }),
  );
}

/** List a conversation's messages (the poll that reads the research reply). */
export function listAssistantMessages(
  assistantId: string,
  conversationId: string,
): Promise<CloudResult<MessagesGetResponses[200]>> {
  return scoped(assistantId, (path, org) =>
    getCloud(
      `${path("messages")}?conversationId=${encodeURIComponent(conversationId)}`,
      MessagesGetSchema,
      { organizationId: org },
    ),
  );
}

/** Post one message (the research prompt / correction / personality turn). */
export function postAssistantMessage(
  assistantId: string,
  body: MessagesPostData["body"],
): Promise<CloudResult<unknown>> {
  return scoped(assistantId, (path, org) =>
    postCloud(path("messages"), z.custom<unknown>(), body, {
      organizationId: org,
    }),
  );
}

/** Archive a throwaway side conversation (best-effort, idempotent). */
export function archiveAssistantConversation(
  assistantId: string,
  conversationId: string,
): Promise<CloudResult<unknown>> {
  return scoped(assistantId, (path, org) =>
    postCloudEmpty(
      path(`conversations/${encodeURIComponent(conversationId)}/archive`),
      z.custom<unknown>(),
      { organizationId: org },
    ),
  );
}

/** Pull the first-party plugin catalog the research prompt advertises. */
export function searchAssistantPlugins(
  assistantId: string,
): Promise<CloudResult<PluginsSearchGetResponses[200]>> {
  return scoped(assistantId, (path, org) =>
    getCloud(path("plugins/search"), PluginsSearchSchema, {
      organizationId: org,
    }),
  );
}

/** Install a plugin under the assistant's workspace (409 = already present). */
export function installAssistantPlugin(
  assistantId: string,
  name: string,
): Promise<CloudResult<unknown>> {
  return scoped(assistantId, (path, org) =>
    postCloud(path("plugins/install"), z.custom<unknown>(), { name }, {
      organizationId: org,
    }),
  );
}

/** Read a workspace sidecar (text files only — callers gate on `isBinary`). */
export function getAssistantWorkspaceFile(
  assistantId: string,
  workspacePath: string,
): Promise<CloudResult<WorkspaceFileGetResponses[200]>> {
  return scoped(assistantId, (path, org) =>
    getCloud(
      `${path("workspace/file")}?path=${encodeURIComponent(workspacePath)}`,
      WorkspaceFileSchema,
      { organizationId: org },
    ),
  );
}

/** Write a workspace sidecar file. */
export function writeAssistantWorkspaceFile(
  assistantId: string,
  workspacePath: string,
  content: string,
): Promise<CloudResult<unknown>> {
  return scoped(assistantId, (path, org) =>
    postCloud(
      path("workspace/write"),
      z.custom<unknown>(),
      { path: workspacePath, content },
      { organizationId: org },
    ),
  );
}

/**
 * Resolve the org header (the scoped surface requires it) and build the
 * assistant-scoped base path. Every call here is scoped
 * `/v1/assistants/{assistant_id}/...`; the id is always encoded so a
 * machine name can never smuggle a path segment.
 */
async function scoped<T>(
  assistantId: string,
  call: (path: (suffix: string) => string, organizationId: string) => Promise<T>,
): Promise<T | { ok: false; status: 0; error: { detail: string } }> {
  const organization = await resolveOrganization();
  if (!organization.ok) {
    return {
      ok: false,
      status: 0,
      error: { detail: "No organization for scoped request." },
    };
  }
  const base = `/v1/assistants/${encodeURIComponent(assistantId)}`;
  return call((suffix) => `${base}/${suffix}`, organization.data);
}
