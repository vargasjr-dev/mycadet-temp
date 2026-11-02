/**
 * The hatch operation's cloud provision core: create the platform-hosted
 * assistant through the cloud API and persist its entry. The narration
 * (the hatch banner, the assistant's ID/name/status) and the cloud token's
 * interactive login are the CLI's ceremony around this door.
 */

import { z } from "zod";
import { cloudAuthHeaders, resolveCloudUrl } from "../../cloud-auth";
import { loopbackSafeFetch } from "../../loopback-fetch";
import { saveLockfileAssistant } from "../../lockfile";
import type { LockfileAssistant } from "../../lockfile-contract";

const CloudErrorDetailSchema = z.object({
  detail: z.string().optional(),
});

const HatchedAssistantSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
});

export interface HatchedCloudAssistant {
  id: string;
  name: string;
  status: string;
}

export type HatchCloudResult =
  | { ok: true; entry: LockfileAssistant; assistant: HatchedCloudAssistant }
  | { ok: false; status: number; error: string };

export async function hatchCloud(params: {
  token: string;
  cloudUrl?: string;
}): Promise<HatchCloudResult> {
  const resolvedUrl = params.cloudUrl || resolveCloudUrl();
  const url = `${resolvedUrl}/v1/assistants/hatch/`;

  try {
    const response = await loopbackSafeFetch(url, {
      method: "POST",
      headers: await cloudAuthHeaders(params.token, params.cloudUrl),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(300_000),
    });

    if (response.ok) {
      const assistant = HatchedAssistantSchema.parse(await response.json());
      const entry: LockfileAssistant = {
        assistantId: assistant.id,
        cloud: "cloud",
        hatchedAt: new Date().toISOString(),
      };
      // The active-assistant switch rides the same locked write.
      saveLockfileAssistant(entry, entry.assistantId);
      return { ok: true, entry, assistant };
    }

    if (response.status === 401 || response.status === 403) {
      const detail = CloudErrorDetailSchema.catch({}).parse(
        await response.json().catch(() => ({})),
      );
      return {
        ok: false,
        status: response.status,
        error:
          detail.detail ??
          "Invalid or expired token. Run `cadet login` to re-authenticate.",
      };
    }

    if (response.status === 402) {
      return {
        ok: false,
        status: 402,
        error: "Insufficient balance to hatch a new assistant.",
      };
    }

    const errorBody = CloudErrorDetailSchema.catch({}).parse(
      await response.json().catch(() => ({})),
    );
    return {
      ok: false,
      status: response.status,
      error:
        errorBody.detail ??
        `Platform API error: ${response.status} ${response.statusText}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
