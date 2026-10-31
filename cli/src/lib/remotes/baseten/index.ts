import { randomUUID } from "node:crypto";
import { green } from "../../color.js";
import { PROVIDER_ENV_VAR_NAMES } from "../../../shared/provider-env-vars.js";
import {
  GATEWAY_PORT,
  getGatewayUrl,
  readLockfile,
  saveBasetenSandboxToken,
  saveLockfileAssistant,
} from "@mycadet/local-mode";
import {
  basetenImageRef,
  createBasetenSandbox,
  pushBasetenImage,
  resolveBasetenToken,
} from "./api.js";
import { BASETEN_IMAGE_NAME, stageBasetenBuildContext } from "./context.js";

/**
 * The Baseten remote — `cadet hatch --remote baseten`.
 *
 * Builds the Cadet sandbox image from the Dockerfile + entrypoint.sh beside
 * this module (version stamped from cli/package.json, optional assistant
 * name piped through), pushes it, and creates a sandbox from it with the
 * provider credentials injected as secret env vars. The installed `baseten`
 * CLI is preferred when present; without one, the same operations ride
 * Baseten's management API directly.
 *
 * The model loop runs IN the sandbox: the image hatches a golden assistant
 * at build time and the sandbox entrypoint wakes it, so once this returns
 * the sandbox is a running Cadet.
 */

/**
 * Every supported provider API key from the caller's environment is injected
 * into the sandbox as a secret env var when present — the same combined map
 * the docker/aws/gcp flows iterate (see shared/provider-env-vars.ts).
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
  return [
    { name: "GATEWAY_PORT", value: String(GATEWAY_PORT), secret: false },
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
}): Promise<string> {
  const assistantId =
    readLockfile().assistants.find(
      (a) => a.cloud === "baseten" && a.name === params.name,
    )?.assistantId ?? randomUUID();
  const entry = {
    assistantId,
    name: params.name,
    cloud: "baseten" as const,
    sandboxUrl: params.sandboxUrl,
    port: params.gatewayPort,
    hatchedAt: new Date().toISOString(),
  };
  saveLockfileAssistant(entry, assistantId);
  try {
    saveBasetenSandboxToken(assistantId, await resolveBasetenToken());
  } catch (err) {
    console.warn(
      `   ⚠️  No Baseten sandbox token saved (${(err as Error).message}).`,
    );
    console.warn(
      "      The desktop proxy needs it to reach the assistant — export BASETEN_API_KEY and re-run the hatch.",
    );
  }
  return getGatewayUrl(entry);
}

export type HatchBasetenParams = {
  name?: string;
  configValues?: Record<string, string>;
  verbose?: boolean;
};

export const hatchBaseten = Object.assign(
  async function hatchBaseten(params: HatchBasetenParams = {}): Promise<void> {
    const { name, verbose = false } = params;
    if (Object.keys(params.configValues ?? {}).length > 0) {
      console.error(
        "Warning: --config values are not wired for the baseten remote yet — ignoring them.",
      );
    }

    const staged = stageBasetenBuildContext({ assistantName: name });
    try {
      console.log("🚀 Pushing the Cadet sandbox image to Baseten...");
      await pushBasetenImage({
        name: BASETEN_IMAGE_NAME,
        dir: staged.dir,
        zip: staged.zip,
        poll: verbose
          ? (status) => console.log(`   image status: ${status}`)
          : undefined,
      });
      console.log(green("   Image built.", process.stdout));

      console.log("🥚 Creating the sandbox...");
      const sandbox = await createBasetenSandbox({
        name,
        image: basetenImageRef(BASETEN_IMAGE_NAME),
        envs: [...sandboxGatewayEnvs(), ...collectProviderEnvs()],
      });

      const sandboxName = sandbox.name ?? name ?? "the sandbox";
      const sandboxUrl = sandbox.url;
      let gatewayUrl: string | undefined;
      if (sandboxUrl) {
        // The gateway's port was pinned at creation, so the sandbox is
        // reachable the moment its gateway is up.
        gatewayUrl = await recordSandbox({
          name: sandboxName,
          sandboxUrl,
          gatewayPort: GATEWAY_PORT,
        });
      } else {
        console.warn(
          "   ⚠️  The sandbox returned no URL — nothing recorded in the lockfile.",
        );
      }
      console.log("");
      console.log(
        green(`✅ Your Cadet sandbox is up: ${sandboxName}`, process.stdout),
      );
      if (sandboxUrl) {
        console.log(`   URL: ${sandboxUrl}`);
        console.log(`   Assistant gateway: ${gatewayUrl}/`);
      }
      console.log(
        `   Exec into it:  baseten sandbox exec --name ${sandboxName} -- 'cadet ps'`,
      );
      console.log("");
    } finally {
      staged.cleanup();
    }
  },
  { description: "Hatch a Cadet sandbox on Baseten" },
);
