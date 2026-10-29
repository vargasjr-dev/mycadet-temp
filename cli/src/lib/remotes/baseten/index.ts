import { green } from "../../color.js";
import {
  basetenImageRef,
  createBasetenSandbox,
  pushBasetenImage,
  resolveBasetenToken,
} from "./api.js";
import {
  BASETEN_IMAGE_NAME,
  stageBasetenBuildContext,
} from "./context.js";

/**
 * The Baseten remote — `cadet hatch --remote baseten`.
 *
 * Builds the Cadet sandbox image from the Dockerfile + entrypoint.sh beside
 * this module (version stamped from cli/package.json, optional assistant
 * name piped through), pushes it through Baseten's management API, and
 * creates a sandbox from it with the provider credentials injected as secret
 * env vars. No local Baseten CLI required.
 *
 * The model loop runs IN the sandbox: the image hatches a golden assistant
 * at build time and the sandbox entrypoint wakes it, so once this returns
 * the sandbox is a running Cadet.
 */

/** Provider credentials worth injecting into the sandbox, when present. */
const PROVIDER_KEY_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
] as const;

function collectProviderEnvs() {
  return PROVIDER_KEY_ENV_VARS.flatMap((name) => {
    const value = process.env[name];
    return value ? [{ name, secret: true, value }] : [];
  });
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
      const token = await resolveBasetenToken();

      console.log("🚀 Pushing the Cadet sandbox image to Baseten...");
      await pushBasetenImage(token, {
        name: BASETEN_IMAGE_NAME,
        zip: staged.zip,
        poll: verbose
          ? (status) => console.log(`   image status: ${status}`)
          : undefined,
      });
      console.log(green("   Image built.", process.stdout));

      console.log("🥚 Creating the sandbox...");
      const sandbox = await createBasetenSandbox(token, {
        name,
        image: basetenImageRef(BASETEN_IMAGE_NAME),
        envs: collectProviderEnvs(),
      });

      const sandboxName = String(sandbox.name ?? name ?? "the sandbox");
      const sandboxUrl = typeof sandbox.url === "string" ? sandbox.url : undefined;
      console.log("");
      console.log(green(`✅ Your Cadet sandbox is up: ${sandboxName}`, process.stdout));
      if (sandboxUrl) {
        console.log(`   URL: ${sandboxUrl}`);
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
