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

import { managedSpeechTtsVoicesRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";

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
 * platform session get an empty catalog.
 */
export function useUnscopedCloudVoices(
  options: { enabled?: boolean } = {},
): UseCloudVoices {
  const { data, isLoading } = useQuery({
    ...managedSpeechTtsVoicesRetrieveOptions(),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
    retry: false,
  });

  return toResult(data, isLoading);
}
