/**
 * The assistant's domain surface, dialed at the bundle's scoped assistant
 * paths — the same `/v1/assistants/{id}` surface every other panel reads.
 * The serving host's chain (gateway proxy, then its cloud forward) carries
 * these to the cloud, so the browser needs no direct cloud session. Every
 * response is parsed at this boundary — the shapes here are the callers'
 * own, not a generated sdk's.
 */

import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const AssistantDomainSchema = z.object({
  id: z.string(),
  subdomain: z.string(),
  created: z.string(),
  modified: z.string(),
});
type AssistantDomain = z.infer<typeof AssistantDomainSchema>;
const DOMAIN_VERIFICATION_STATUSES = [
  "verified",
  "pending",
  "failed",
  "not_started",
  "unknown",
] as const;
export type DomainVerificationStatus =
  (typeof DOMAIN_VERIFICATION_STATUSES)[number];

const DomainVerificationStatusSchema = z.object({
  domain: z.string(),
  status: z.enum(DOMAIN_VERIFICATION_STATUSES),
  message: z.string(),
});

/** A paginated list body; the rows the callers read ride in `results`. */
async function fetchList<T extends z.ZodTypeAny>(
  path: string,
  rowSchema: T,
): Promise<z.infer<T>[]> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`The domain dial failed (${response.status})`);
  }
  const body = z
    .object({ results: z.array(rowSchema) })
    .parse(await response.json());
  return body.results;
}

async function dial(
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const detail = await response
      .json()
      .then((body) => (body as { detail?: unknown }).detail)
      .catch(() => null);
    throw new Error(
      typeof detail === "string"
        ? detail
        : `The domain dial failed (${response.status})`,
    );
  }
  return response.json().catch(() => null);
}

const scoped = (assistantId: string, tail: string) =>
  `/v1/assistants/${encodeURIComponent(assistantId)}/${tail}`;

/** The domain surface's query keys, in one place so invalidations stay honest. */
export const domainKeys = {
  domains: (assistantId: string) => ["domains", assistantId],
  domainVerificationStatus: (assistantId: string, id: string) => [
    "domains",
    assistantId,
    id,
    "verification-status",
  ],
};

export function useDomains(assistantId: string) {
  return useQuery({
    queryKey: domainKeys.domains(assistantId),
    enabled: !!assistantId,
    queryFn: () => fetchList(scoped(assistantId, "domains/"), AssistantDomainSchema),
  });
}

export function useDomainVerificationStatus(
  assistantId: string,
  domainId: string | undefined,
  opts?: {
    refetchInterval?:
      | number
      | false
      | ((query: {
          state: { data?: { status?: DomainVerificationStatus } };
        }) => number | false);
    refetchOnWindowFocus?: boolean;
  },
) {
  return useQuery({
    queryKey: domainKeys.domainVerificationStatus(assistantId, domainId ?? ""),
    enabled: !!assistantId && !!domainId,
    refetchInterval: opts?.refetchInterval,
    refetchOnWindowFocus: opts?.refetchOnWindowFocus,
    queryFn: async () =>
      DomainVerificationStatusSchema.parse(
        await dial(scoped(assistantId, `domains/${encodeURIComponent(domainId ?? "")}/verification-status/`)),
      ),
  });
}

export function useCreateDomain(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { subdomain: string; email_username?: string }) =>
      dial(scoped(assistantId, "domains/"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: domainKeys.domains(assistantId),
      });
    },
  });
}

export function useDestroyDomain(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (domainId: string) =>
      dial(scoped(assistantId, `domains/${encodeURIComponent(domainId)}/`), {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: domainKeys.domains(assistantId),
      });
    },
  });
}

export function useProvisionDomain(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (domainId: string) =>
      dial(scoped(assistantId, `domains/${encodeURIComponent(domainId)}/provision/`), {
        method: "POST",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: domainKeys.domains(assistantId),
      });
    },
  });
}
