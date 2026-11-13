/**
 * The hatch operation's cloud provision core: create the platform-hosted
 * assistant through the cloud API and persist its entry. The platform token
 * is derived here from the stored login; the narration (the hatch banner,
 * the assistant's ID/name/status) is the CLI's ceremony around this door.
 */

import { z } from "zod";
import { cloudAuthHeaders, readCloudToken } from "../../cloud-auth";
import { getCloudBaseUrl } from "@mycadet/shared";
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

export async function hatchCloud(): Promise<HatchCloudResult> {
  // The token is the caller's stored platform login — readCloudToken is the
  // same credential every cloud command rides, so the hatch derives it here
  // instead of making callers thread it through.
  const token = readCloudToken();
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "Not logged in. Run `cadet login --token <token>` first.",
    };
  }
  const cloudUrl = getCloudBaseUrl();
  const url = `${cloudUrl}/v1/assistants/hatch/`;

  try {
    const response = await loopbackSafeFetch(url, {
      method: "POST",
      headers: await cloudAuthHeaders(token, cloudUrl),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(300_000),
    });

    if (response.ok) {
      const assistant = HatchedAssistantSchema.parse(await response.json());
      const entry: LockfileAssistant = {
        assistantId: assistant.id,
        cloud: "cloud",
        // The platform's display name — the same row every other remote's
        // entry carries, so the post-hatch summary reads it from the entry.
        name: assistant.name,
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
