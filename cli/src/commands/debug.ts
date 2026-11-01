import { z } from "zod";
import { getGatewayUrl } from "@mycadet/local-mode/contract";
import {
  authHeadersForKnownOrganization,
  cloudAuthHeaders,
  getAssistantDisplayName,
  getCloudUrl,
  loopbackSafeFetch,
  readCloudToken,
} from "@mycadet/local-mode";
import { cliCommand } from "../lib/cli-name.js";
import { isCloudHome } from "../lib/cloud-values.js";
import { type LockfileAssistant } from "@mycadet/local-mode/contract";
import { resolveTargetAssistant } from "../lib/assistant-config.js";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import { loadGuardianToken, leaseGuardianToken } from "../lib/guardian-token";

// Renew a cached guardian token that is about to lapse instead of starting
// a long export on it.
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

function printHelp(): void {
  console.log(`Usage: cadet debug [name]

Send Cadet staff a debug bundle of a self-hosted assistant so they can
inspect its diagnostic logs and sanitized configuration. The archive
never holds credentials.

Arguments:
  name    Assistant ID or unique display name. Defaults to the active
          assistant (see 'cadet use'). Multi-word names need no quotes.

Requirements:
  - 'Allow Staff Access' is on for the assistant (Settings > Privacy).
  - You are logged in ('cadet login'), which also registers the
    assistant with the cloud.
  - The assistant is self-hosted. Cadet-hosted assistants need no bundle;
    staff clone them directly.

Side effects:
  - Uploads the bundle to Cadet's debug-bundle storage, where it is
    deleted after 7 days. Nothing on this machine changes.
  - Records a 'debug bundle exported' entry in your account's audit history.
  - Waits for the diagnostic upload to finish.

Examples:
  cadet debug
  cadet debug my-assistant
  cadet debug Support Bot
`);
}

export const debug = Object.assign(
  async function debug(): Promise<void> {
    const args = process.argv.slice(3);
    if (args.includes("--help") || args.includes("-h")) {
      printHelp();
      return;
    }

    const entry = resolveTargetAssistant(parseAssistantTargetArg(args));
    const reference = getAssistantDisplayName(entry);
    if (isCloudHome(entry.cloud)) {
      console.error(
        `${reference} is hosted by Cadet, so staff can clone it directly. No bundle is needed.`,
      );
      process.exit(1);
    }

    const cloudToken = readCloudToken();
    if (!cloudToken) {
      console.error(`Not logged in. Run '${cliCommand()} login' first.`);
      process.exit(1);
    }
    // The self-hosted registration fields ride the local-runtime and platform
    // branches — custom/baseten remotes are never registered.
    if (entry.cloud === "custom" || entry.cloud === "baseten") {
      console.error(
        `${reference} is not registered with the cloud yet. Run 'cadet login' and retry.`,
      );
      process.exit(1);
    }
    const cloudAssistantId = entry.cloudAssistantId?.trim();
    if (!cloudAssistantId) {
      console.error(
        `${reference} is not registered with the cloud yet. Run 'cadet login' and retry.`,
      );
      process.exit(1);
    }
    const cloudUrl = entry.cloudBaseUrl?.trim() || getCloudUrl();
    const organizationId = entry.cloudOrganizationId?.trim();

    const accessToken = await daemonAccessToken(entry, reference, false);
    const headers = organizationId
      ? authHeadersForKnownOrganization(cloudToken, organizationId)
      : await cloudAuthHeaders(cloudToken, cloudUrl);
    const urlResponse = await loopbackSafeFetch(
      `${cloudUrl}/v1/assistants/${encodeURIComponent(cloudAssistantId)}/debug-bundle-upload-url/`,
      { method: "POST", headers },
    );
    if (urlResponse.status === 403) {
      console.error(
        "Staff access is off for this assistant. Turn on 'Allow Staff Access' in Settings > Privacy, then retry.",
      );
      process.exit(1);
    }
    if (!urlResponse.ok) {
      const detail = await urlResponse.text().catch(() => "");
      console.error(
        `Error: Could not get an upload URL (${urlResponse.status}): ${detail || urlResponse.statusText}`,
      );
      process.exit(1);
    }
    const { url: uploadUrl } = z
      .object({ url: z.string().url() })
      .parse(await urlResponse.json());
    const logs = await loopbackSafeFetch(
      `${getGatewayUrl(entry)}/v1/logs/export`,
      {
        method: "POST",
        signal: AbortSignal.timeout(180_000),
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    if (!logs.ok) {
      throw new Error(`Diagnostic export failed (HTTP ${logs.status}).`);
    }
    const upload = await fetch(uploadUrl, {
      method: "PUT",
      signal: AbortSignal.timeout(300_000),
      headers: { "Content-Type": "application/octet-stream" },
      body: await logs.blob(),
    });
    if (!upload.ok) {
      throw new Error(`Diagnostic upload failed (HTTP ${upload.status}).`);
    }
    console.log(
      "Debug bundle sent to Cadet. Staff can open it for the next 7 days.",
    );
  },
  { description: "Send Cadet staff a debug bundle of a self-hosted assistant" },
);

async function daemonAccessToken(
  entry: LockfileAssistant,
  reference: string,
  forceRefresh: boolean,
): Promise<string> {
  if (!forceRefresh) {
    const cached = loadGuardianToken(entry.assistantId);
    if (
      cached &&
      new Date(cached.accessTokenExpiresAt).getTime() - Date.now() >
        TOKEN_EXPIRY_MARGIN_MS
    ) {
      return cached.accessToken;
    }
  }
  try {
    return (await leaseGuardianToken(entry)).accessToken;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      console.error(`Error: Could not connect to ${reference}. Is it running?`);
      process.exit(1);
    }
    throw err;
  }
}
