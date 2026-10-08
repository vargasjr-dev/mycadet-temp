import { getPlatformUrl } from "./platform-client.js";
import { dockerhubImages } from "./docker.js";
import type { ServiceName } from "./docker.js";
import { loopbackSafeFetch } from "./loopback-fetch.js";

/**
 * Release channel to resolve releases for. `stable` is the default and maps
 * to the server's `stable=true` filter. `preview` opts into the Cadet
 * Cloud's preview channel — the newest release regardless of stability —
 * used by callers (e.g. managed-assistant upgrades) that want the latest
 * preview release.
 */
export type ReleaseChannel = "stable" | "preview";

/**
 * Map a channel to `fetchReleases` options. `stable` passes no `channel`
 * param so the server keeps its `stable=true` default (we don't rely on an
 * unverified `channel=stable` filter); `preview` requests the preview
 * channel explicitly.
 */
function releasesOptsFor(channel: ReleaseChannel): { channel?: "preview" } {
  return channel === "preview" ? { channel: "preview" } : {};
}

export interface ReleaseListItem {
  version: string;
  is_stable?: boolean;
  assistant_image_ref?: string | null;
  gateway_image_ref?: string | null;
  credential_executor_image_ref?: string | null;
}

/**
 * The endpoint defaults `limit` to 10, which is too few to validate an
 * explicit --version against ("absent from the list" is treated as a hard
 * error) — always request the documented maximum.
 */
const RELEASES_FETCH_LIMIT = 100;

/**
 * Fetch the releases list from Cadet Cloud, optionally filtered by channel
 * (the `channel` param takes precedence over `stable` server-side).
 * `platformUrl` overrides the lockfile/env-resolved default — pass the
 * target assistant's platform URL when it may differ from the active one.
 * Returns `null` when Cadet Cloud is unreachable or responds non-OK —
 * distinct from `[]` (it answered, no releases).
 */
export async function fetchReleases(opts?: {
  channel?: "stable" | "preview";
  platformUrl?: string;
}): Promise<ReleaseListItem[] | null> {
  try {
    const platformUrl = opts?.platformUrl || getPlatformUrl();
    const filter = opts?.channel ? `channel=${opts.channel}` : "stable=true";
    const response = await loopbackSafeFetch(
      `${platformUrl}/v1/releases/?${filter}&limit=${RELEASES_FETCH_LIMIT}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) return null;
    return (await response.json()) as ReleaseListItem[];
  } catch {
    return null;
  }
}

/**
 * Fetch the latest release version for a channel from the Cadet Cloud API.
 * Returns the version string (e.g. "0.7.0") or null if unavailable.
 * The releases endpoint returns entries ordered newest-first, so the first
 * entry is the latest for the requested channel.
 */
export async function fetchLatestVersion(
  channel: ReleaseChannel = "stable",
): Promise<string | null> {
  const releases = await fetchReleases(releasesOptsFor(channel));
  return releases?.[0]?.version ?? null;
}

/**
 * Fetch the latest stable release version. Thin back-compat wrapper around
 * {@link fetchLatestVersion} for existing callers.
 */
export async function fetchLatestStableVersion(): Promise<string | null> {
  return fetchLatestVersion("stable");
}

/**
 * Image refs for a target version: the tag is the target version, the repo
 * follows the CLI's own version shape (dev CLI → `-dev` repos).
 */
export function resolveImageRefs(
  targetVersion: string,
  cliVersion: string,
): Record<ServiceName, string> {
  const versionTag = targetVersion.startsWith("v")
    ? targetVersion
    : `v${targetVersion}`;
  const images = dockerhubImages(cliVersion);
  return {
    assistant: `${images.assistant}:${versionTag}`,
    "credential-executor": `${images["credential-executor"]}:${versionTag}`,
    gateway: `${images.gateway}:${versionTag}`,
  };
}

/** Convenience wrapper for "the images this CLI itself was built from". */
export function resolveOwnImageRefs(
  cliVersion: string,
): Record<ServiceName, string> {
  return resolveImageRefs(cliVersion ? `v${cliVersion}` : "latest", cliVersion);
}
