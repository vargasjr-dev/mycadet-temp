import { randomUUID } from "node:crypto";
import type { LockfileAssistant } from "../../lockfile-contract";
import { GATEWAY_PORT, getGatewayUrl } from "../../lockfile-contract";
import { readLockfile, saveLockfileAssistant } from "../../lockfile";
import {
  consoleLifecycleReporter,
  type LifecycleReporter,
} from "../../lifecycle-reporter";
import { PROVIDER_ENV_VAR_NAMES } from "../../provider-env-vars";
import { saveBasetenSandboxToken } from "../../guardian-token";
import {
  BASETEN_GATEWAY_PREVIEW,
  createBasetenPreviewToken,
  ensureBasetenGatewayPreview,
} from "./api";
import {
  basetenImageRef,
  createBasetenSandbox,
  pushBasetenImage,
  resolveBasetenToken,
} from "./api";
import { BASETEN_IMAGE_NAME, stageBasetenBuildContext } from "./context";

/**
 * The hatch operation's Baseten provision core: build the Cadet sandbox
 * image (Dockerfile + entrypoint.sh beside this module, version stamped
 * from the caller's release version, optional assistant name piped
 * through), push it, and create a sandbox from it with the provider
 * credentials injected as secret env vars. The installed `baseten` CLI is
 * preferred when present; without one, the same operations ride Baseten's
 * management API directly.
 *
 * The model loop runs IN the sandbox: the image hatches a golden assistant
 * at build time and the sandbox entrypoint wakes it, so once this returns
 * the sandbox is a running Cadet.
 */

/**
 * Every supported provider API key from the caller's environment is injected
 * into the sandbox as a secret env var when present — the same combined map
 * the docker/aws/gcp flows iterate (see provider-env-vars).
 */
function collectProviderEnvs() {
  return Object.values(PROVIDER_ENV_VAR_NAMES).flatMap((name) => {
    const value = process.env[name];
    return value ? [{ name, secret: true, value }] : [];
  });
}

/**
 * The gateway port, pinned a priori: Baseten clients address HTTP services
 * through the sandbox API server's `/port/<PORT>/` route, so the port can't
 * be discovered after the fact — it rides the sandbox's environment as
 * `GATEWAY_PORT` (the env the stack already honors) and the same number is
 * recorded in the lockfile entry.
 */
function sandboxGatewayEnvs() {
  return [{ name: "GATEWAY_PORT", value: String(GATEWAY_PORT), secret: false }];
}

/**
 * The optional state volume: `BASETEN_SANDBOX_VOLUME=NAME[:MOUNT_PATH]`
 * mounts one of Baseten's persistent volumes (at most one per sandbox; the
 * volume must already exist — `baseten volume push <dir> bdn:<ns>/<name>`
 * creates it) and points the assistant's state paths at it. Without it the
 * sandbox's state lives on the platform's in-memory filesystem, where every
 * file the running assistant writes (instance dir, lockfile, tokens, logs)
 * counts against the sandbox's RAM until the sandbox dies with it.
 */
export function sandboxStateVolume(): { name: string; mountPath: string } | undefined {
  const raw = process.env.BASETEN_SANDBOX_VOLUME?.trim();
  if (!raw) return undefined;
  const separator = raw.indexOf(":");
  const name = separator < 0 ? raw : raw.slice(0, separator);
  const mountPath = separator < 0 ? "/data" : raw.slice(separator + 1);
  if (!name || !mountPath.startsWith("/")) {
    throw new Error(
      `BASETEN_SANDBOX_VOLUME must be NAME or NAME:MOUNT_PATH (absolute), got '${raw}'.`,
    );
  }
  return { name, mountPath };
}

/**
 * The state paths a mounted volume takes over: XDG overrides are the one
 * seam every local-mode path resolves through, so pointing both homes into
 * the volume moves the assistant's instance dir, lockfile, tokens, and logs
 * onto it wholesale. Plain envs: they are configuration, not credentials.
 */
export function sandboxStateVolumeEnvs(
  mountPath: string,
): Array<{ name: string; value: string; secret: boolean }> {
  return [
    { name: "XDG_DATA_HOME", value: `${mountPath}/xdg-data`, secret: false },
    { name: "XDG_CONFIG_HOME", value: `${mountPath}/xdg-config`, secret: false },
  ];
}

/**
 * Record the sandbox in the lockfile and persist its access token so the
 * desktop proxy can route to it: the entry carries the sandbox server URL
 * (the gateway is `{url}/port/{port}`), the token file beside the lockfile
 * carries the bearer. A re-hatch of the same sandbox name reuses its entry
 * (and its token file) rather than orphaning the old record. The token is
 * minted from BASETEN_API_KEY; without one (the installed-CLI arm needs no
 * key) the URL still records — the proxy reports the missing token
 * per-request until a re-hatch saves it. Returns the entry's derived gateway
 * URL (the one the lockfile now records).
 */
async function recordSandbox(params: {
  name: string;
  sandboxUrl: string;
  gatewayPort: number;
  reporter: LifecycleReporter;
}): Promise<{ entry: LockfileAssistant; gatewayUrl: string }> {
  const warn = (msg: string) => params.reporter.warn(msg);
  const assistantId =
    readLockfile().assistants.find(
      (a) => a.cloud === "baseten" && a.name === params.name,
    )?.assistantId ?? randomUUID();
  let entry: LockfileAssistant = {
    assistantId,
    name: params.name,
    cloud: "baseten",
    sandboxUrl: params.sandboxUrl,
    port: params.gatewayPort,
    hatchedAt: new Date().toISOString(),
  };
  // Both doors are required: the sandbox URL (exec) and the preview URL
  // (every gateway invocation) land together or the hatch fails. The
  // lockfile's READ stays permissive — one legacy entry missing a field
  // would blank the whole file on parse — but no NEW entry is written
  // half-doored.
  const sandboxToken = await resolveBasetenToken();

  // The gateway's door: a private preview on the gateway port. The
  // preview edge opens the port dynamically and guards the URL with a
  // preview token, so `Authorization` stays free for the gateway's own
  // bearer end to end — servers send the token as a header, browsers
  // earn a cookie with one authenticated open.
  const preview = await ensureBasetenGatewayPreview(
    params.name,
    params.gatewayPort,
  );
  if (!preview.url) {
    throw new Error(
      "The gateway preview mint returned no URL — the assistant would be unreachable from browsers.",
    );
  }
  const previewToken = await createBasetenPreviewToken(
    params.name,
    BASETEN_GATEWAY_PREVIEW,
    new Date(Date.now() + BASETEN_PREVIEW_TOKEN_LIFETIME_MS),
  );
  entry = { ...entry, previewUrl: preview.url };
  saveLockfileAssistant(entry, assistantId);
  saveBasetenSandboxToken(assistantId, sandboxToken, previewToken);
  return { entry, gatewayUrl: getGatewayUrl(entry) };
}

/** A preview token outlives the sandbox token's 2h ceiling by design — it
 * is the door credential, rotated on every re-hatch. */
const BASETEN_PREVIEW_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export type HatchBasetenParams = {
  name?: string;
  configValues?: Record<string, string>;
  verbose?: boolean;
  /** The caller's release version — stamped into the image build. */
  version?: string;
  /** The narration sink (defaults to the console reporter). */
  reporter?: LifecycleReporter;
};

export type HatchBasetenResult =
  | { ok: true; entry: LockfileAssistant; ready: boolean }
  | { ok: false; status: number; error: string };

export async function hatchBaseten(
  params: HatchBasetenParams,
): Promise<HatchBasetenResult> {
  const { name, verbose = false } = params;
  const reporter = params.reporter ?? consoleLifecycleReporter;
  const log = (msg: string) => reporter.log(msg);
  const warn = (msg: string) => reporter.warn(msg);
  try {
    if (Object.keys(params.configValues ?? {}).length > 0) {
      log(
        "Warning: --config values are not wired for the baseten remote yet — ignoring them.",
      );
    }

    const staged = stageBasetenBuildContext({
      version: params.version ?? "",
      assistantName: name,
    });
    try {
      log("🚀 Pushing the Cadet sandbox image to Baseten...");
      await pushBasetenImage({
        name: BASETEN_IMAGE_NAME,
        dir: staged.dir,
        zip: staged.zip,
        poll: verbose
          ? (status) => log(`   image status: ${status}`)
          : undefined,
      });
      log("   Image built.");

      log("🥚 Creating the sandbox...");
      const stateVolume = sandboxStateVolume();
      const sandbox = await createBasetenSandbox({
        name,
        image: basetenImageRef(BASETEN_IMAGE_NAME),
        envs: [
          ...sandboxGatewayEnvs(),
          ...(stateVolume ? sandboxStateVolumeEnvs(stateVolume.mountPath) : []),
          ...collectProviderEnvs(),
        ],
        ...(stateVolume ? { volume: stateVolume } : {}),
        ports: [{ name: "gateway", protocol: "HTTP", target: GATEWAY_PORT }],
      });

      const sandboxName = sandbox.name ?? name ?? "the sandbox";
      const sandboxUrl = sandbox.url;
      if (sandboxUrl) {
        // The gateway's port was pinned at creation, so the sandbox is
        // reachable the moment its gateway is up.
        log(`🥚 Hatching Baseten assistant: ${sandboxName}`);
        const { entry, gatewayUrl } = await recordSandbox({
          name: sandboxName,
          sandboxUrl,
          gatewayPort: GATEWAY_PORT,
          reporter,
        });
        log(`   URL: ${sandboxUrl}`);
        log(`   Assistant gateway: ${gatewayUrl}/`);
        log(
          `   Exec into it:  baseten sandbox exec --name ${sandboxName} -- 'cadet ps'`,
        );
        return { ok: true, entry, ready: false };
      }
      log(
        "   ⚠️  The sandbox returned no URL — nothing recorded in the lockfile.",
      );
      return {
        ok: false,
        status: 502,
        error: "The Baseten sandbox returned no URL — nothing was recorded.",
      };
    } finally {
      staged.cleanup();
    }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
