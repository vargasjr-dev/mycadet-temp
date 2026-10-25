/**
 * Fetches the cloud TTS voice catalog. Fetch-only: the cloud is the single
 * source of truth for offered voices and the default, so until the catalog
 * loads (or when it fails) `voices` is empty and pickers render nothing rather
 * than a stale local list.
 *
 * Read straight from the cloud control plane, for callers that have a platform
 * session. Callers that can't reach the cloud (self-hosted, gateway-only) get
 * an empty catalog and pickers render nothing. App twin of web's
 * `use-cloud-voices`, riding the app's own cloud request client instead of the
 * generated SDK.
 */

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { resolveOrganization } from "@app/lib/cloud/organization";
import { getCloud } from "@app/lib/cloud/request";

/** A cloud voice as offered to the UI. */
export interface CloudVoiceOption {
  model: string;
  label: string;
  description: string;
  sampleUrl: string;
  source: string;
}

export interface UseCloudVoices {
  /** Offered voices; empty until the cloud catalog loads (or on failure). */
  voices: readonly CloudVoiceOption[];
  /** Platform default model; null until fetched or when none is offered. */
  defaultModel: string | null;
  /** True once the cloud catalog has loaded. */
  fetched: boolean;
  /**
   * A fetch is in flight. Distinct from `!fetched`, which is also true when the
   * catalog is disabled or has failed: surfaces that show a pending state need
   * to tell "still coming" from "not coming".
   */
  loading: boolean;
}

interface VoiceCatalogResponse {
  voices?: readonly CloudVoiceOption[];
  defaultModel?: string | null;
}

const CLOUD_SPEECH_VOICES_URL = "/v1/cloud-speech/tts/voices/";

const VoiceCatalogSchema = z.object({
  voices: z
    .array(
      z.object({
        model: z.string(),
        label: z.string(),
        description: z.string(),
        sampleUrl: z.string(),
        source: z.string(),
      }),
    )
    .optional(),
  defaultModel: z.string().nullable().optional(),
});

/**
 * The catalog read straight from the cloud. The only transport: every voice
 * surface reads the cloud directly and callers without a platform session get
 * an empty catalog.
 */
export function useUnscopedCloudVoices(
  options: { enabled?: boolean } = {},
): UseCloudVoices {
  const query = useQuery({
    queryKey: ["cloud-speech", "tts", "voices"],
    queryFn: async (): Promise<VoiceCatalogResponse | null> => {
      const organization = await resolveOrganization();
      if (!organization.ok) {
        return null;
      }
      const result = await getCloud<VoiceCatalogResponse>(
        CLOUD_SPEECH_VOICES_URL,
        VoiceCatalogSchema,
        { organizationId: organization.data },
      );
      return result.ok ? result.data : null;
    },
    enabled: options.enabled ?? true,
    staleTime: 60_000,
    retry: false,
  });

  return {
    voices: query.data?.voices ?? [],
    defaultModel: query.data?.defaultModel ?? null,
    fetched: query.data != null,
    loading: query.isLoading,
  };
}
