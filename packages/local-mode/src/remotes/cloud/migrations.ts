/**
 * The cloud's migration API: signed-URL bundle upload/download, the
 * GCS import (preflight + import) and the unified job-status poll. The
 * shared client behind the cloud restore and teleport flows — callers
 * thread the session token; the base URL defaults to the environment's
 * cloud stack, and a cloud entry's gateway address rides in its place
 * (the gateway proxies the same routes).
 */

import { z } from "zod";
import { cloudAuthHeaders, invalidateOrgIdCache } from "../../cloud-auth";
import { getCloudBaseUrl } from "@mycadet/shared";
import { loopbackSafeFetch } from "../../loopback-fetch";

const PassthroughBodySchema = z.record(z.string(), z.unknown()).catch({});

const BundleUploadUrlSchema = z.object({
  url: z.string(),
  bundle_key: z.string(),
  expires_at: z.string(),
  max_content_length: z.number().optional(),
});

const BundleImportErrorSchema = z
  .object({
    detail: z.string().optional(),
    reason: z.string().optional(),
    bundle_compat: z
      .object({
        min_runtime_version: z.string(),
        max_runtime_version: z.string().nullable(),
      })
      .optional()
      .catch(undefined),
    target_runtime_version: z.string().optional(),
  })
  .catch({});

const RawUnifiedJobStatusSchema = z.object({
  job_id: z.string(),
  type: z.enum(["export", "import"]),
  status: z.enum(["processing", "complete", "failed"]),
  bundle_key: z.string().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Signed-URL upload flow
// ---------------------------------------------------------------------------

export async function cloudUploadToSignedUrl(
  uploadUrl: string,
  bundleData: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const response = await loopbackSafeFetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: new Blob([bundleData]),
    signal: AbortSignal.timeout(600_000),
  });

  if (!response.ok) {
    throw new Error(
      `Upload to signed URL failed: ${response.status} ${response.statusText}`,
    );
  }
}

export async function cloudImportPreflightFromGcs(
  bundleKey: string,
  token: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const resolvedUrl = getCloudBaseUrl();
  const response = await loopbackSafeFetch(
    `${resolvedUrl}/v1/migrations/import-preflight-from-gcs/`,
    {
      method: "POST",
      headers: await cloudAuthHeaders(token),
      signal: AbortSignal.timeout(30 * 60_000),
      body: JSON.stringify({ bundle_key: bundleKey }),
    },
  );

  const body = PassthroughBodySchema.parse(
    await response.json().catch(() => ({})),
  );
  return { statusCode: response.status, body };
}

export async function cloudImportBundleFromGcs(
  bundleKey: string,
  token: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const resolvedUrl = getCloudBaseUrl();
  const response = await loopbackSafeFetch(
    `${resolvedUrl}/v1/migrations/import-from-gcs/`,
    {
      method: "POST",
      headers: await cloudAuthHeaders(token),
      body: JSON.stringify({ bundle_key: bundleKey }),
      signal: AbortSignal.timeout(30 * 60_000),
    },
  );

  if (response.status === 413) {
    throw new Error("Bundle too large to import");
  }

  const body = PassthroughBodySchema.parse(
    await response.json().catch(() => ({})),
  );
  return { statusCode: response.status, body };
}

// ---------------------------------------------------------------------------
// Unified signed-url + job-status endpoints (teleport-gcs-unify)
// ---------------------------------------------------------------------------

/**
 * Discriminated union representing the unified migration job status shape
 * returned by `GET /v1/migrations/jobs/{job_id}/` on both the cloud and
 * the local runtime.
 */
type UnifiedJobStatus =
  | {
      jobId: string;
      type: "export" | "import";
      status: "processing";
    }
  | {
      jobId: string;
      type: "export" | "import";
      status: "complete";
      bundleKey?: string;
      result?: unknown;
    }
  | {
      jobId: string;
      type: "export" | "import";
      status: "failed";
      error: string;
    };

interface RawUnifiedJobStatus {
  job_id: string;
  type: "export" | "import";
  status: "processing" | "complete" | "failed";
  bundle_key?: string;
  result?: unknown;
  error?: string;
}

/**
 * Normalise the wire-format job-status payload into the TypeScript
 * discriminated union. Shared between platform and local-runtime helpers
 * since both endpoints return the same shape.
 */
function parseUnifiedJobStatus(raw: RawUnifiedJobStatus): UnifiedJobStatus {
  if (raw.status === "processing") {
    return { jobId: raw.job_id, type: raw.type, status: "processing" };
  }
  if (raw.status === "complete") {
    return {
      jobId: raw.job_id,
      type: raw.type,
      status: "complete",
      bundleKey: raw.bundle_key,
      result: raw.result,
    };
  }
  return {
    jobId: raw.job_id,
    type: raw.type,
    status: "failed",
    error: raw.error ?? "Job failed without an error message",
  };
}

interface BundleCompatibility {
  min_runtime_version: string;
  max_runtime_version: string | null;
}

/**
 * Thrown by cloudRequestSignedUrl when the cloud rejects a download
 * signed-URL request because the target runtime version is outside the
 * ExportJob's [min_runtime_version, max_runtime_version] band. Terminal
 * — callers must NOT retry; surface to the user and abort the
 * teleport/restore wizard.
 */
export class VersionMismatchError extends Error {
  readonly bundleCompat: BundleCompatibility;
  readonly targetRuntimeVersion: string;

  constructor(bundleCompat: BundleCompatibility, targetRuntimeVersion: string) {
    super(
      VersionMismatchError.formatMessage(bundleCompat, targetRuntimeVersion),
    );
    this.name = "VersionMismatchError";
    this.bundleCompat = bundleCompat;
    this.targetRuntimeVersion = targetRuntimeVersion;
  }

  static formatMessage(
    compat: BundleCompatibility,
    targetRuntimeVersion: string,
  ): string {
    const range = compat.max_runtime_version
      ? `${compat.min_runtime_version}–${compat.max_runtime_version}`
      : `${compat.min_runtime_version}+`;
    return (
      `Cannot import: bundle requires runtime ${range}, but this runtime is ${targetRuntimeVersion}. ` +
      `Update your runtime before importing.`
    );
  }
}

/**
 * Request a signed URL from the cloud for either uploading a new bundle
 * or downloading an existing one. Calls `POST /v1/migrations/signed-url/`.
 *
 * - `operation: "upload"` (optionally with `contentType` / `contentLength`)
 *   returns a URL the client can PUT a bundle to.
 * - `operation: "download"` with a `bundleKey` returns a URL the local
 *   runtime can GET the bundle from during an import-from-GCS flow.
 *
 * Retries once with a fresh org-ID cache on 401 to match the retry pattern
 * used by other authenticated platform helpers.
 *
 * Throws {@link VersionMismatchError} on a 422 `version_mismatch` response,
 * which is terminal — callers must NOT retry.
 */
export async function cloudRequestSignedUrl(
  params: {
    operation: "upload" | "download";
    bundleKey?: string;
    contentType?: string;
    contentLength?: number;
    // Source-side, upload only: runtime version that produced the bundle.
    minRuntimeVersion?: string;
    maxRuntimeVersion?: string | null;
    // Target-side, download only: runtime version that will import.
    targetRuntimeVersion?: string;
    // Upload only: who will PUT to the URL. "runtime" signs against the
    // runtime-reachable storage endpoint so a cloud assistant pod can
    // upload its export bundle (platform→local teleport); defaults to
    // "client" server-side. No effect in production, where both endpoints
    // are the same.
    consumer?: "client" | "runtime";
  },
  token: string,
): Promise<{
  url: string;
  bundleKey: string;
  expiresAt: string;
  maxContentLength?: number;
}> {
  const resolvedUrl = getCloudBaseUrl();
  const body: Record<string, unknown> = { operation: params.operation };
  if (params.bundleKey !== undefined) body.bundle_key = params.bundleKey;
  if (params.contentType !== undefined) body.content_type = params.contentType;
  if (params.contentLength !== undefined) {
    body.content_length = params.contentLength;
  }
  if (params.minRuntimeVersion !== undefined) {
    body.min_runtime_version = params.minRuntimeVersion;
  }
  if (params.maxRuntimeVersion !== undefined) {
    // Explicit null is the documented "no upper bound" sentinel; keep it
    // in the payload rather than stripping to undefined.
    body.max_runtime_version = params.maxRuntimeVersion;
  }
  if (params.targetRuntimeVersion !== undefined) {
    body.target_runtime_version = params.targetRuntimeVersion;
  }
  if (params.consumer !== undefined) {
    body.consumer = params.consumer;
  }

  const doRequest = async (): Promise<Response> =>
    loopbackSafeFetch(`${resolvedUrl}/v1/migrations/signed-url/`, {
      method: "POST",
      headers: await cloudAuthHeaders(token),
      body: JSON.stringify(body),
    });

  let response = await doRequest();

  if (response.status === 401) {
    // Invalidate the cached org-ID (if any) and retry once with a fresh
    // lookup. For session-token callers, a 401 frequently means the
    // cached org ID is stale — calling doRequest() again without clearing
    // the cache would just send the same stale header and fail again.
    invalidateOrgIdCache(token);
    response = await doRequest();
  }

  if (response.status === 201 || response.status === 200) {
    const json = BundleUploadUrlSchema.parse(await response.json());
    return {
      url: json.url,
      bundleKey: json.bundle_key,
      expiresAt: json.expires_at,
      maxContentLength: json.max_content_length,
    };
  }

  // Non-success body. Read once and reuse for both the 422 version-mismatch
  // branch and the generic-error fallthrough — `response.json()` consumes
  // the body, so a second read would always return undefined.
  const errorBody = BundleImportErrorSchema.parse(
    await response.json().catch(() => ({})),
  );

  if (
    response.status === 422 &&
    errorBody.reason === "version_mismatch" &&
    errorBody.bundle_compat &&
    typeof errorBody.target_runtime_version === "string"
  ) {
    throw new VersionMismatchError(
      errorBody.bundle_compat,
      errorBody.target_runtime_version,
    );
  }

  throw new Error(
    errorBody.detail ??
      `Failed to request signed URL: ${response.status} ${response.statusText}`,
  );
}

/**
 * Poll the unified job-status endpoint on the cloud. Calls
 * `GET /v1/migrations/jobs/{jobId}/` and parses into {@link UnifiedJobStatus}.
 */
export async function cloudPollJobStatus(
  jobId: string,
  token: string,
): Promise<UnifiedJobStatus> {
  const resolvedUrl = getCloudBaseUrl();
  const response = await loopbackSafeFetch(
    `${resolvedUrl}/v1/migrations/jobs/${jobId}/`,
    {
      headers: await cloudAuthHeaders(token),
    },
  );

  if (response.status === 404) {
    throw new Error("Migration job not found");
  }

  if (!response.ok) {
    throw new Error(
      `Job status check failed: ${response.status} ${response.statusText}`,
    );
  }

  const raw = RawUnifiedJobStatusSchema.parse(await response.json());
  return parseUnifiedJobStatus(raw);
}
