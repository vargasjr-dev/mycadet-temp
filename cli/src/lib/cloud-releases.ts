import { z } from "zod";

import { CADET_GITHUB_REPOSITORY } from "./github-repository.js";
import { getCloudUrl } from "./cloud-client.js";
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

const ReleaseListItemSchema = z.object({
  version: z.string().min(1),
  is_stable: z.boolean().optional(),
  assistant_image_ref: z.string().nullable().optional(),
  gateway_image_ref: z.string().nullable().optional(),
  credential_executor_image_ref: z.string().nullable().optional(),
});

export type ReleaseListItem = z.infer<typeof ReleaseListItemSchema>;

const STABLE_VERSION = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const GitHubReleaseSchema = z.object({
  tag_name: z.string().regex(STABLE_VERSION),
  draft: z.literal(false),
  prerelease: z.literal(false),
});

async function fetchLatestGitHubStableVersion(): Promise<string | null> {
  try {
    const response = await loopbackSafeFetch(
      `https://api.github.com/repos/${CADET_GITHUB_REPOSITORY}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      return null;
    }
    const parsed = GitHubReleaseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.tag_name.replace(/^v/, "") : null;
  } catch {
    return null;
  }
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
 * `cloudUrl` overrides the lockfile/env-resolved default — pass the
 * target assistant's platform URL when it may differ from the active one.
 * Returns `null` when Cadet Cloud is unreachable or responds non-OK —
 * distinct from `[]` (it answered, no releases).
 */
export async function fetchReleases(opts?: {
  channel?: "stable" | "preview";
  cloudUrl?: string;
}): Promise<ReleaseListItem[] | null> {
  try {
    const cloudUrl = opts?.cloudUrl || getCloudUrl();
    const filter = opts?.channel ? `channel=${opts.channel}` : "stable=true";
    const response = await loopbackSafeFetch(
      `${cloudUrl}/v1/releases/?${filter}&limit=${RELEASES_FETCH_LIMIT}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) {
      return null;
    }
    const parsed = z
      .array(ReleaseListItemSchema)
      .safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the latest release version from Cadet Cloud, falling back to GitHub
 * for stable releases when the cloud has no usable result.
 * Returns the version string (e.g. "0.7.0") or null if unavailable.
 * The releases endpoint returns entries ordered newest-first, so the first
 * entry is the latest for the requested channel.
 */
export async function fetchLatestVersion(
  channel: ReleaseChannel = "stable",
): Promise<string | null> {
  const releases = await fetchReleases(releasesOptsFor(channel));
  if (channel === "preview") {
    return releases?.[0]?.version ?? null;
  }
  const latest = releases?.find(
    (release) =>
      release.is_stable !== false && STABLE_VERSION.test(release.version),
  );
  return latest?.version ?? fetchLatestGitHubStableVersion();
}

/**
 * Fetch the latest stable release version. Thin back-compat wrapper around
 * {@link fetchLatestVersion} for existing callers.
 */
export async function fetchLatestStableVersion(): Promise<string | null> {
  return fetchLatestVersion("stable");
}

/**
 * Image refs for a target version: the tag is the target version exactly as
 * the release workflows push it — bare ("0.12.8", "0.12.8-dev…"); a
 * git-tag-style "v" prefix on the input is tolerated and stripped. The repo
 * follows the CLI's own version shape (dev CLI → `-dev` repos).
 */
export function resolveImageRefs(
  targetVersion: string,
  cliVersion: string,
): Record<ServiceName, string> {
  const versionTag = targetVersion.startsWith("v")
    ? targetVersion.slice(1)
    : targetVersion;
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
  return resolveImageRefs(cliVersion || "latest", cliVersion);
}
