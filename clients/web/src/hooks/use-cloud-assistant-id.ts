import { useEffect, useState } from "react";

import { resolveLocalAssistantCloudIdentity } from "@/lib/local-cloud-identity";
import { CloudIdentityInjectionError } from "@/lib/cloud-identity-errors";

type CloudAssistantIdState = {
  cloudAssistantId: string | null;
  isLoading: boolean;
  error: Error | null;
};

/**
 * Resolve the active assistant's **platform** id for platform-API path
 * params. Local-mode lockfile ids are slugs (e.g. `cadet-dark-cub`),
 * but every platform assistant route uses a `<uuid:assistant_id>` path
 * converter — a slug id falls off Django's URL table and surfaces as a
 * bare "Not found". Platform-hosted ids (already UUIDs) resolve to
 * themselves without any network round-trip.
 */
export function useCloudAssistantId(
  assistantId: string | null | undefined,
  enabled: boolean,
): CloudAssistantIdState {
  const [state, setState] = useState<CloudAssistantIdState>({
    cloudAssistantId: null,
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    if (!enabled || !assistantId) {
      setState({ cloudAssistantId: null, isLoading: false, error: null });
      return;
    }

    let active = true;
    setState({ cloudAssistantId: null, isLoading: true, error: null });

    void resolveLocalAssistantCloudIdentity(assistantId)
      .then((resolvedCloudAssistantId) => {
        if (!active) {
          return;
        }
        setState({
          cloudAssistantId: resolvedCloudAssistantId,
          isLoading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        // The registration exists even when the local side did not finish,
        // and a path param needs only the id.
        if (error instanceof CloudIdentityInjectionError) {
          setState({
            cloudAssistantId: error.cloudAssistantId,
            isLoading: false,
            error: null,
          });
          return;
        }
        setState({
          cloudAssistantId: null,
          isLoading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });

    return () => {
      active = false;
    };
  }, [assistantId, enabled]);

  return state;
}
