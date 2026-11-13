/**
 * Fetches the cloud TTS voice catalog. Fetch-only: the cloud is the single
 * source of truth for offered voices and the default, so until the catalog
 * loads (or when it fails) `voices` is empty and pickers render nothing rather
 * than a stale local list.
 *
 * Read straight from the cloud, for callers that have a platform session. The
 * daemon's managed-voices proxy is gone with the managed (Cadet) speech
 * provider, so there is no assistant-scoped transport anymore — callers that
 * can't reach the cloud (self-hosted, gateway-only) get an empty catalog and
 * pickers render nothing.
 */

import { useQuery } from "@tanstack/react-query";

/**
 * A cloud voice as offered to the UI. `source` is a plain `string` so
 * voices the cloud serves before this client learns their source still
 * type-check.
 */
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

function toResult(
  data: VoiceCatalogResponse | undefined,
  isLoading: boolean,
): UseCloudVoices {
  return {
    voices: data?.voices ?? [],
    defaultModel: data?.defaultModel ?? null,
    fetched: !!data,
    loading: isLoading,
  };
}

/**
 * The catalog read straight from the cloud. The only transport left: the
 * daemon's managed-voices proxy was deleted along with managed (Cadet) speech,
 * so every voice surface reads the cloud directly and callers without a
 * platform session get an empty catalog. The dial is the cloud's own
 * unscoped spelling on whichever plane serves the bundle, so a
 * cloud-hosted bundle hits the real route and a self-hosted one 404s
 * into the empty catalog it has always shown.
 */
export function useUnscopedCloudVoices(
  options: { enabled?: boolean } = {},
): UseCloudVoices {
  const { data, isLoading } = useQuery({
    queryKey: ["cloud-speech", "tts", "voices"],
    enabled: options.enabled ?? true,
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<VoiceCatalogResponse> => {
      // The catalog read is a deliberate same-origin swap of the generated
      // cloud dial: the cloud serves the route on cloud-hosted bundles and
      // a self-hosted host 404s into the empty catalog it has always
      // shown. The generated client's device/registration headers are
      // identity hints the catalog read does not need.
      // eslint-disable-next-line no-restricted-syntax -- the catalog read is host-plane; see above
      const response = await fetch("/v1/cloud-speech/tts/voices/");
      if (!response.ok) {
        throw new Error(`The voice catalog dial failed (${response.status})`);
      }
      return (await response.json()) as VoiceCatalogResponse;
    },
  });

  return toResult(data, isLoading);
}
