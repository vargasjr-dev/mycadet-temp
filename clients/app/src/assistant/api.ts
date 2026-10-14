import { getCloud, type CloudResult } from "@app/lib/cloud/request";
import { resolveOrganization } from "@app/lib/cloud/organization";
import {
  AssistantPageSchema,
  type Assistant,
} from "@app/assistant/assistant-schema";

export type ListAssistantsResult = CloudResult<Assistant[]>;

/** List every hosting type and page under one organization, without web's API/store. */
export async function listAssistants(
  options: { signal?: AbortSignal } = {},
): Promise<ListAssistantsResult> {
  const organization = await resolveOrganization(options.signal);
  if (!organization.ok) {
    return organization;
  }
  const results: Assistant[] = [];
  for (let page = 0; page < 20; page++) {
    const result = await getCloud(
      `/v1/assistants/?hosting=all&limit=100&offset=${results.length}`,
      AssistantPageSchema,
      {
        organizationId: organization.data,
        signal: options.signal,
      },
    );
    if (!result.ok) {
      return result;
    }
    results.push(...result.data.results);
    if (!result.data.next || result.data.results.length === 0) {
      return { ok: true, status: result.status, data: results };
    }
  }
  return {
    ok: false,
    status: 200,
    error: { detail: "Assistant list exceeded the page cap." },
  };
}
