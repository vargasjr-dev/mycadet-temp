/**
 * The assistant's mail surface, dialed through the operator api's
 * host-served rows: the hop to the cloud happens on the operator's own
 * credentials, so the browser never needs a cloud session to read mail.
 * Every response is parsed at this boundary — the shapes here are the
 * panel's own, not the generated cloud sdk's.
 */

import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const EmailMessageSchema = z.object({
  id: z.string(),
  direction: z.string(),
  from_address: z.string(),
  to_addresses: z.array(z.string()),
  subject: z.string(),
  created_at: z.string(),
});
export type MailMessage = z.infer<typeof EmailMessageSchema>;

const EmailAddressSchema = z.object({
  id: z.string(),
  address: z.string(),
  created_at: z.string(),
});
export type MailAddress = z.infer<typeof EmailAddressSchema>;

const AssistantDomainSchema = z.object({
  id: z.string(),
  subdomain: z.string(),
  created: z.string(),
  modified: z.string(),
});
type MailDomain = z.infer<typeof AssistantDomainSchema>;

const EmailAddressStatusSchema = z.object({
  address: z.string(),
  status: z.string(),
  usage: z.object({
    sent_today: z.number(),
    daily_limit: z.number(),
    received_today: z.number(),
    sent_this_month: z.number(),
    received_this_month: z.number(),
  }),
  created_at: z.string(),
});
export type MailAddressStatus = z.infer<typeof EmailAddressStatusSchema>;

const DOMAIN_VERIFICATION_STATUSES = [
  "verified",
  "pending",
  "failed",
  "not_started",
  "unknown",
] as const;
export type MailDomainVerificationStatus =
  (typeof DOMAIN_VERIFICATION_STATUSES)[number];

const DomainVerificationStatusSchema = z.object({
  domain: z.string(),
  status: z.enum(DOMAIN_VERIFICATION_STATUSES),
  message: z.string(),
});

const entries = (query: Record<string, unknown>): [string, string][] =>
  Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, String(v)]);

/** A paginated list body; the rows the callers read ride in `results`. */
async function fetchList<T extends z.ZodTypeAny>(
  path: string,
  rowSchema: T,
): Promise<z.infer<T>[]> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`The mail dial failed (${response.status})`);
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
        : `The mail dial failed (${response.status})`,
    );
  }
  return response.json().catch(() => null);
}

const scoped = (assistantId: string, tail: string) =>
  `/v1/assistants/${encodeURIComponent(assistantId)}/${tail}`;

/** The mail surface's query keys, in one place so invalidations stay honest. */
export const mailKeys = {
  emails: (assistantId: string) => ["emails", assistantId],
  emailAddresses: (assistantId: string) => ["email-addresses", assistantId],
  emailAddressStatus: (assistantId: string, id: string) => [
    "email-addresses",
    assistantId,
    id,
    "status",
  ],
  domains: (assistantId: string) => ["domains", assistantId],
  domainVerificationStatus: (assistantId: string, id: string) => [
    "domains",
    assistantId,
    id,
    "verification-status",
  ],
};

export function useMailEmails(
  assistantId: string,
  query?: { direction?: "inbound" | "outbound"; limit?: number; enabled?: boolean },
) {
  const { enabled, ...params } = query ?? {};
  return useQuery({
    queryKey: [...mailKeys.emails(assistantId), params ?? null],
    enabled: !!assistantId && (enabled ?? true),
    queryFn: () =>
      fetchList(
        scoped(
          assistantId,
          `emails/${params ? `?${new URLSearchParams(entries(params))}` : ""}`,
        ),
        EmailMessageSchema,
      ),
  });
}

export function useMailEmailAddresses(
  assistantId: string,
  opts?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: mailKeys.emailAddresses(assistantId),
    enabled: !!assistantId && (opts?.enabled ?? true),
    queryFn: () =>
      fetchList(scoped(assistantId, "email-addresses/"), EmailAddressSchema),
  });
}

export function useMailEmailAddressStatus(
  assistantId: string,
  addressId: string | undefined,
  opts?: { enabled?: boolean; refetchOnWindowFocus?: boolean },
) {
  return useQuery({
    queryKey: mailKeys.emailAddressStatus(assistantId, addressId ?? ""),
    enabled: !!assistantId && !!addressId && (opts?.enabled ?? true),
    refetchOnWindowFocus: opts?.refetchOnWindowFocus,
    queryFn: async () =>
      EmailAddressStatusSchema.parse(
        await dial(scoped(assistantId, `email-addresses/${encodeURIComponent(addressId ?? "")}/status/`)),
      ),
  });
}

export function useMailDomains(assistantId: string) {
  return useQuery({
    queryKey: mailKeys.domains(assistantId),
    enabled: !!assistantId,
    queryFn: () => fetchList(scoped(assistantId, "domains/"), AssistantDomainSchema),
  });
}

export function useMailDomainVerificationStatus(
  assistantId: string,
  domainId: string | undefined,
  opts?: {
    refetchInterval?:
      | number
      | false
      | ((query: {
          state: { data?: { status?: MailDomainVerificationStatus } };
        }) => number | false);
    refetchOnWindowFocus?: boolean;
  },
) {
  return useQuery({
    queryKey: mailKeys.domainVerificationStatus(assistantId, domainId ?? ""),
    enabled: !!assistantId && !!domainId,
    refetchInterval: opts?.refetchInterval,
    refetchOnWindowFocus: opts?.refetchOnWindowFocus,
    queryFn: async () =>
      DomainVerificationStatusSchema.parse(
        await dial(scoped(assistantId, `domains/${encodeURIComponent(domainId ?? "")}/verification-status/`)),
      ),
  });
}

export function useMailCreateEmailAddress(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { username: string }) =>
      dial(scoped(assistantId, "email-addresses/"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: mailKeys.emailAddresses(assistantId),
      });
    },
  });
}

export function useMailDestroyEmailAddress(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (addressId: string) =>
      dial(
        scoped(assistantId, `email-addresses/${encodeURIComponent(addressId)}/`),
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: mailKeys.emailAddresses(assistantId),
      });
    },
  });
}

export function useMailCreateDomain(assistantId: string) {
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
        queryKey: mailKeys.domains(assistantId),
      });
    },
  });
}

export function useMailDestroyDomain(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (domainId: string) =>
      dial(scoped(assistantId, `domains/${encodeURIComponent(domainId)}/`), {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: mailKeys.domains(assistantId),
      });
    },
  });
}

export function useMailProvisionDomain(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (domainId: string) =>
      dial(scoped(assistantId, `domains/${encodeURIComponent(domainId)}/provision/`), {
        method: "POST",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: mailKeys.domains(assistantId),
      });
    },
  });
}
