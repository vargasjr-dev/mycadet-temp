/**
 * Baseten sandbox plumbing for the baseten remote. The installed `baseten`
 * CLI is preferred when present — it streams build logs and owns its own
 * auth; without one, the same operations ride the management API over fetch:
 *   https://docs.baseten.co/reference/management-api/sandboxes/overview
 *
 * The HTTP path authenticates with a short-lived sandbox access token,
 * exchanged from BASETEN_API_KEY.
 */

import { z } from "zod";
import { captureBasetenCli, resolveBasetenCli, runBasetenCli } from "./baseten-cli.js";

const BASETEN_API_BASE = "https://api.baseten.co";

export type BasetenEnvs = Array<{
  name: string;
  secret: boolean;
  value: string;
}>;

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

const SandboxCreated = z.object({
  name: z.string().optional().catch(undefined),
  url: z.string().optional().catch(undefined),
  status: z.string().optional().catch(undefined),
});

export type BasetenSandboxCreated = z.infer<typeof SandboxCreated>;

async function basetenFetch<S extends z.ZodType>(
  token: string,
  path: string,
  schema: S,
  init: RequestInit = {},
): Promise<z.infer<S>> {
  const response = await fetch(`${BASETEN_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const raw: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = ErrorBody.parse(raw);
    throw new BasetenApiError(
      response.status,
      error.code ?? "UNKNOWN",
      error.message || response.statusText,
      error.details.request_id,
    );
  }
  return schema.parse(raw);
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
 * Short-lived bearer token for the sandbox API, exchanged from
 * BASETEN_API_KEY at POST /v1/token.
 */
export async function resolveBasetenToken(): Promise<string> {
  const apiKey = process.env.BASETEN_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Baseten credentials not found. Export BASETEN_API_KEY first.",
    );
  }
  const issued = await basetenFetch(apiKey, "/v1/token", TokenIssued, {
    method: "POST",
    body: JSON.stringify({ scopes: ["sandboxes"] }),
  });
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
 * build. With the baseten CLI installed this streams
 * `baseten sandbox image push --wait`; otherwise it rides the management
 * API: POST /v1/sandboxes/images hands back an upload URL for the ZIP
 * archive, uploading starts the build, and the image is polled until BUILT
 * or FAILED.
 */
export async function pushBasetenImage(options: {
  name: string;
  /** The staged build context — the CLI pushes it with --dir. */
  dir: string;
  /** The ZIP'd context — the HTTP path uploads it to the returned URL. */
  zip: () => Promise<Buffer>;
  poll?: (status: string) => void;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<void> {
  if (await resolveBasetenCli()) {
    return runBasetenCli([
      "sandbox",
      "image",
      "push",
      "--name",
      options.name,
      "--dir",
      options.dir,
      "--wait",
    ]);
  }

  const token = await resolveBasetenToken();
  const accepted = await basetenFetch(
    token,
    "/v1/sandboxes/images",
    ImagePushAccepted,
    {
      method: "POST",
      body: JSON.stringify({ name: options.name }),
    },
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
    const image = await basetenFetch(
      token,
      `/v1/sandboxes/images/${encodeURIComponent(options.name)}`,
      ImageStatus,
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
 * Create a sandbox from an image. Creation waits until the sandbox is ready
 * and returns it; `envs` is the credential-injection path (marked secret so
 * Baseten masks the values). The CLI arm reports through its own streamed
 * output and only echoes back the requested name.
 */
export async function createBasetenSandbox(options: {
  name?: string;
  image: string;
  envs?: BasetenEnvs;
}): Promise<BasetenSandboxCreated> {
  if (await resolveBasetenCli()) {
    const args = ["sandbox", "create", "--image", options.image];
    if (options.name) args.push("--name", options.name);
    for (const env of options.envs ?? []) {
      // `--env` marks the value secret (masked in configuration responses);
      // `--plain-env` stays readable — configuration like a gateway port is
      // not a credential and wants to be describable.
      const flag = env.secret ? "--env" : "--plain-env";
      args.push(flag, `${env.name}=${env.value}`);
    }
    await runBasetenCli(args);
    if (options.name) {
      const url = await describeBasetenSandboxUrl(options.name);
      return { name: options.name, ...(url ? { url } : {}) };
    }
    return { name: options.name };
  }

  const token = await resolveBasetenToken();
  return basetenFetch(token, "/v1/sandboxes/instances", SandboxCreated, {
    method: "POST",
    body: JSON.stringify({
      image: options.image,
      ...(options.name ? { name: options.name } : {}),
      ...(options.envs?.length ? { envs: options.envs } : {}),
    }),
  });
}

/**
 * The sandbox server URL off the installed CLI — `describe --jq '.url'` —
 * with the jq quoting (`"https://..."`) stripped. Empty string when the CLI
 * declines (name not found yet, pre-release output changes): the caller
 * treats a miss as "no URL recorded" rather than a failed hatch.
 */
export async function describeBasetenSandboxUrl(name: string): Promise<string> {
  try {
    const out = await captureBasetenCli([
      "sandbox",
      "describe",
      "--name",
      name,
      "--jq",
      ".url",
    ]);
    return out.replace(/^"(.*)"$/, "$1");
  } catch (err) {
    console.warn(`   Could not describe the sandbox URL: ${err}`);
    return "";
  }
}
