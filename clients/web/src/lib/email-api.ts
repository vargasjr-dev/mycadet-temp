/**
 * The assistant's mail surface, dialed at the bundle's scoped assistant
 * paths — the same `/v1/assistants/{id}` surface every other panel reads.
 * The serving host's chain (gateway proxy, then its cloud forward) carries
 * these to the cloud, so the browser needs no direct cloud session. Every
 * response is parsed at this boundary — the shapes here are the panel's
 * own, not a generated sdk's.
 */

import { z } from "zod";

import { dial, okOrThrow } from "@/lib/dial";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const EmailMessageSchema = z.object({
  id: z.string(),
  direction: z.string(),
  from_address: z.string(),
  to_addresses: z.array(z.string()),
  subject: z.string(),
  created_at: z.string(),
});
export type EmailMessage = z.infer<typeof EmailMessageSchema>;

const EmailAddressSchema = z.object({
  id: z.string(),
  address: z.string(),
  created_at: z.string(),
});
export type EmailAddress = z.infer<typeof EmailAddressSchema>;

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
export type EmailAddressStatus = z.infer<typeof EmailAddressStatusSchema>;

const entries = (query: Record<string, unknown>): [string, string][] =>
  Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, String(v)]);

/** A paginated list body; the rows the callers read ride in `results`. */
async function fetchList<T extends z.ZodTypeAny>(
  path: string,
  rowSchema: T,
): Promise<z.infer<T>[]> {
  const body = z
    .object({ results: z.array(rowSchema) })
    .parse(okOrThrow(await dial(path), "The email dial failed"));
  return body.results;
}

const scoped = (assistantId: string, tail: string) =>
  `/v1/assistants/${encodeURIComponent(assistantId)}/${tail}`;

/** The email surface's query keys, in one place so invalidations stay honest. */
export const emailKeys = {
  emails: (assistantId: string) => ["emails", assistantId],
  emailAddresses: (assistantId: string) => ["email-addresses", assistantId],
  emailAddressStatus: (assistantId: string, id: string) => [
    "email-addresses",
    assistantId,
    id,
    "status",
  ],
};

export function useEmails(
  assistantId: string,
  query?: {
    direction?: "inbound" | "outbound";
    limit?: number;
    enabled?: boolean;
  },
) {
  const { enabled, ...params } = query ?? {};
  return useQuery({
    queryKey: [...emailKeys.emails(assistantId), params ?? null],
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

export function useEmailAddresses(
  assistantId: string,
  opts?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: emailKeys.emailAddresses(assistantId),
    enabled: !!assistantId && (opts?.enabled ?? true),
    queryFn: () =>
      fetchList(scoped(assistantId, "email-addresses/"), EmailAddressSchema),
  });
}

export function useEmailAddressStatus(
  assistantId: string,
  addressId: string | undefined,
  opts?: { enabled?: boolean; refetchOnWindowFocus?: boolean },
) {
  return useQuery({
    queryKey: emailKeys.emailAddressStatus(assistantId, addressId ?? ""),
    enabled: !!assistantId && !!addressId && (opts?.enabled ?? true),
    refetchOnWindowFocus: opts?.refetchOnWindowFocus,
    queryFn: async () =>
      EmailAddressStatusSchema.parse(
        okOrThrow(
          await dial(
            scoped(
              assistantId,
              `email-addresses/${encodeURIComponent(addressId ?? "")}/status/`,
            ),
          ),
          "The email dial failed",
        ),
      ),
  });
}

export function useCreateEmailAddress(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { username: string }) =>
      okOrThrow(
        await dial(scoped(assistantId, "email-addresses/"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        "The email dial failed",
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: emailKeys.emailAddresses(assistantId),
      });
    },
  });
}

export function useDestroyEmailAddress(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (addressId: string) =>
      okOrThrow(
        await dial(
          scoped(
            assistantId,
            `email-addresses/${encodeURIComponent(addressId)}/`,
          ),
          { method: "DELETE" },
        ),
        "The email dial failed",
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: emailKeys.emailAddresses(assistantId),
      });
    },
  });
}
