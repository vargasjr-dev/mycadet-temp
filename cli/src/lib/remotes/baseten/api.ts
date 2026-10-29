/**
 * Minimal Baseten HTTP client for the sandbox endpoints the baseten remote
 * needs. No local Baseten CLI — everything rides the management API:
 *   https://docs.baseten.co/reference/management-api/sandboxes/overview
 *
 * Requests authenticate with a short-lived sandbox access token, exchanged
 * from BASETEN_API_KEY (or an explicit BASETEN_SANDBOX_TOKEN).
 */

import { z } from "zod";

const BASETEN_API_BASE = "https://api.baseten.co";

export type BasetenEnvs = Array<{ name: string; secret: boolean; value: string }>;

type Json = Record<string, unknown>;

/** Any JSON object, tolerated to `{}` — responses beyond that are errors. */
const JsonRecord = z.record(z.string(), z.unknown()).catch({});

/** The error envelope the management API returns on failures. */
const ErrorBody = z.object({
  code: z.string().optional().catch(undefined),
  message: z.string().optional().catch(undefined),
  details: z
    .object({ request_id: z.string().optional().catch(undefined) })
    .catch({}),
});

const TokenIssued = z.object({
  token: z.string().min(1).optional().catch(undefined),
});

const ImagePushAccepted = z.object({
  upload_url: z.string().optional().catch(undefined),
  status: z.string().optional().catch(undefined),
});

const ImageStatus = z.object({
  status: z.string().optional().catch(undefined),
});

async function basetenFetch(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Json> {
  const response = await fetch(`${BASETEN_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const raw: unknown = await response.json().catch(() => ({}));
  const body = JsonRecord.parse(raw);
  if (!response.ok) {
    const error = ErrorBody.parse(body);
    throw new BasetenApiError(
      response.status,
      error.code ?? "UNKNOWN",
      error.message || response.statusText,
      error.details.request_id,
    );
  }
  return body;
}

export class BasetenApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(
      `Baseten API ${status} (${code}): ${message}` +
        (requestId ? ` [request_id ${requestId}]` : ""),
    );
  }
}

/**
 * Short-lived bearer token for the sandbox API. BASETEN_SANDBOX_TOKEN wins
 * when set (callers that already minted one can pass it through); otherwise
 * BASETEN_API_KEY is exchanged at POST /v1/token.
 */
export async function resolveBasetenToken(): Promise<string> {
  const existing = process.env.BASETEN_SANDBOX_TOKEN;
  if (existing) return existing;
  const apiKey = process.env.BASETEN_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Baseten credentials not found. Export BASETEN_API_KEY (or BASETEN_SANDBOX_TOKEN) first.",
    );
  }
  const issued = TokenIssued.parse(
    await basetenFetch(apiKey, "/v1/token", {
      method: "POST",
      body: JSON.stringify({ scopes: ["sandboxes"] }),
    }),
  );
  if (!issued.token) {
    throw new Error("Baseten token exchange returned no token.");
  }
  return issued.token;
}

/** A sandbox image's registered reference, `sandbox/<name>:latest`. */
export function basetenImageRef(name: string): string {
  return `sandbox/${name}:latest`;
}

/**
 * Push a build context as a new image version and wait for the Baseten-side
 * build: POST /v1/sandboxes/images hands back an upload URL for the ZIP
 * archive, uploading starts the build, and the image is polled until BUILT
 * or FAILED.
 */
export async function pushBasetenImage(
  token: string,
  options: {
    name: string;
    zip: () => Promise<Buffer>;
    poll?: (status: string) => void;
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<void> {
  const accepted = ImagePushAccepted.parse(
    await basetenFetch(token, "/v1/sandboxes/images", {
      method: "POST",
      body: JSON.stringify({ name: options.name }),
    }),
  );
  const uploadUrl = accepted.upload_url;

  if (!uploadUrl) {
    throw new Error(
      `Baseten image push returned no upload URL (status ${accepted.status ?? "unknown"}).`,
    );
  }
  const archive = await options.zip();
  const uploaded = await fetch(uploadUrl, {
    method: "PUT",
    body: new Uint8Array(archive),
    headers: { "Content-Type": "application/zip" },
  });
  if (!uploaded.ok) {
    throw new Error(
      `Uploading the Baseten image archive failed: ${uploaded.status} ${uploaded.statusText}.`,
    );
  }

  const timeoutMs = options.timeoutMs ?? 20 * 60_000;
  const intervalMs = options.intervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const image = ImageStatus.parse(
      await basetenFetch(
        token,
        `/v1/sandboxes/images/${encodeURIComponent(options.name)}`,
      ),
    );
    const status = image.status ?? "UNKNOWN";
    options.poll?.(status);
    if (status === "BUILT") return;
    if (status === "FAILED") {
      throw new Error(
        `Baseten image build failed — inspect the build logs for '${options.name}'.`,
      );
    }
  }
  throw new Error(
    `Baseten image build did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`,
  );
}

/**
 * Create a sandbox from an image. Creation waits server-side until the
 * sandbox is ready and returns it; `envs` is the credential-injection path
 * (marked secret so Baseten masks the values).
 */
export async function createBasetenSandbox(
  token: string,
  options: { name?: string; image: string; envs?: BasetenEnvs },
): Promise<Json> {
  return basetenFetch(token, "/v1/sandboxes/instances", {
    method: "POST",
    body: JSON.stringify({
      image: options.image,
      ...(options.name ? { name: options.name } : {}),
      ...(options.envs?.length ? { envs: options.envs } : {}),
    }),
  });
}
