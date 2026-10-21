import { type QueryClient, useQuery } from "@tanstack/react-query";

import { listAssistants } from "@/assistant/api";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  isAvatarSuperseded,
  markAvatarSuperseded,
} from "@/lib/avatar-supersede";
import { isCadetCloudRemote } from "@/lib/local-mode";
import { useAuthStore, useHasCloudSession } from "@/stores/auth-store";
import { useRequestOrganizationId } from "@/stores/organization-store";
import {
  resolveCloudAssistantId,
  useResolvedAssistantsStore,
} from "@/stores/resolved-assistants-store";

export type CloudAvatarUrls = ReadonlyMap<string, string>;

const EMPTY_AVATAR_URLS: CloudAvatarUrls = new Map();

/** Matches the row-level avatar clocks so a re-synced thumbnail shows within a minute. */
export const CLOUD_AVATAR_URLS_STALE_TIME_MS = 60_000;

/**
 * Keyed by user and organization: a sign-out never serves another account's
 * thumbnails, and an org switch rescopes the list with the request header.
 */
export function cloudAvatarUrlsQueryKey(
  userId: string | null,
  organizationId: string | null,
) {
  return ["cloudAvatarUrls", userId, organizationId] as const;
}

const CLOUD_AVATAR_URLS_KEY_PREFIX = ["cloudAvatarUrls"] as const;

/**
 * Drops one platform id from every cached map without refetching and marks
 * it superseded (see `avatar-supersede`): live evidence outranks a URL
 * observed earlier, and the cloud copy lags the daemon's async sync, so
 * an immediate refetch would only re-serve the stale URL. A list in flight
 * keeps its siblings and lands without this id; nothing is cancelled. The
 * first refetch after the window restores it.
 */
export function suppressPlatformAvatarUrl(
  queryClient: QueryClient,
  cloudAssistantId: string,
): void {
  markAvatarSuperseded(cloudAssistantId);
  queryClient.setQueriesData<CloudAvatarUrls>(
    { queryKey: CLOUD_AVATAR_URLS_KEY_PREFIX },
    (urls) => {
      if (!urls?.has(cloudAssistantId)) {
        return urls;
      }
      const next = new Map(urls);
      next.delete(cloudAssistantId);
      return next;
    },
  );
}

/**
 * Everything a fresher local avatar read outranks for `assistantId`: the
 * row's synced `avatarUrl` and its platform lookup entry. A paired row keyed
 * by its local slug is also suppressed under its platform UUID once the
 * paired daemon answers, since that is the key the list carries.
 */
export function supersedeCloudAvatar(
  queryClient: QueryClient,
  assistantId: string,
): void {
  const store = useResolvedAssistantsStore.getState();
  store.clearAvatarUrl(assistantId);
  suppressPlatformAvatarUrl(
    queryClient,
    resolveCloudAssistantId(assistantId),
  );
  const row = store.assistants.find((a) => a.id === assistantId);
  if (row?.isPaired && !row.cloudAssistantId) {
    // Dynamic: the resolver reaches the auth store, which reaches this
    // module through the avatar hooks.
    void import("@/lib/paired-cloud-identity")
      .then((m) => m.resolvePairedAssistantCloudId(assistantId))
      .then((platformId) => {
        if (platformId) {
          suppressPlatformAvatarUrl(queryClient, platformId);
        }
      });
  }
}

/**
 * Throws on failure so React Query keeps the last good map through a failed
 * poll; with no prior data the hook reads that as an empty map, and a
 * chooser row falls back to its other sources, never an error.
 */
async function fetchCloudAvatarUrls(): Promise<CloudAvatarUrls> {
  const result = await listAssistants();
  if (!result.ok) {
    throw new Error(`Failed to list assistants (${result.status})`);
  }
  const urls = new Map<string, string>();
  for (const assistant of result.data) {
    if (assistant.avatar_url && !isAvatarSuperseded(assistant.id)) {
      urls.set(assistant.id, assistant.avatar_url);
    }
  }
  return urls;
}

/**
 * Platform `avatar_url` by assistant id, read-only. One shared query feeds
 * every chooser row, so the list is fetched once per stale window however
 * many rows mount. Enabled only when a live platform session exists outside
 * the cloud-remote bundle; elsewhere the resolved store already carries
 * `avatarUrl` and this resolves to an empty map. Never writes the resolved
 * store: the API list must not clobber their rows, and this lookup keeps
 * that contract.
 */
export function useCloudAvatarUrls(): CloudAvatarUrls {
  const hasCloudSession = useHasCloudSession();
  const userId = useAuthStore.use.user()?.id ?? null;
  const isOrgReady = useIsOrgReady();
  const organizationId = useRequestOrganizationId();
  const query = useQuery<CloudAvatarUrls>({
    queryKey: cloudAvatarUrlsQueryKey(userId, organizationId),
    queryFn: fetchCloudAvatarUrls,
    enabled: hasCloudSession && isOrgReady && !isCadetCloudRemote(),
    staleTime: CLOUD_AVATAR_URLS_STALE_TIME_MS,
    // staleTime alone never refetches a chooser that stays mounted, and a
    // sibling's change on another client sends no event here; poll while
    // the window is in the foreground.
    refetchInterval: CLOUD_AVATAR_URLS_STALE_TIME_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
  return query.data ?? EMPTY_AVATAR_URLS;
}
