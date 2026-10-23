/**
 * Cadet Cloud login session machinery — browser PKCE flow, loopback callback,
 * and the post-login local-assistant registration/injection half of the
 * desktop app's LocalAssistantBootstrapService flow. Shared by the
 * `cadet login` command and `cadet hatch` (which completes a Cadet Cloud
 * login when the user picks that provider).
 */

import { pollingCloudLogin } from "./cloud-login-poll.js";
import { randomBytes } from "crypto";
import { createServer } from "http";
import type { AddressInfo } from "net";

import { isCloudHome } from "./cloud-values.js";
import {
  resolveAssistant,
  saveLockfileAssistant,
} from "./assistant-config.js";
import { resolveAssistantApiKeyForInjection } from "./assistant-api-key-resolution.js";
import { computeDeviceId } from "./guardian-token.js";
import { openBrowser } from "./open-browser.js";
import {
  fetchCurrentUser,
  fetchOrganizationId,
  ensureSelfHostedLocalRegistration,
  getCloudUrl,
  injectCredentialsIntoAssistant,
  readCloudToken,
  saveCloudToken,
} from "./cloud-client.js";
import { fetchAssistantIngressUrl } from "./upgrade-lifecycle.js";
import { fetchCurrentVersion } from "./http-client.js";
import {
  CALLBACK_PATH,
  buildAuthorizeUrl,
  exchangeAccessTokenForSession,
  exchangeCodeWithWorkos,
  fetchWorkosClientId,
  generatePkcePair,
} from "./workos-pkce.js";

const LOGIN_TIMEOUT_MS = 300_000;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderLoginPage(
  title: string,
  subtitle: string,
  success: boolean,
): string {
  const checkmarkSvg = `<svg class="icon" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="28" cy="28" r="28" fill="var(--positive-bg)"/>
      <path class="check" d="M17 28.5L24.5 36L39 21" stroke="var(--positive-fg)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>`;

  const errorSvg = `<svg class="icon" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="28" cy="28" r="28" fill="var(--negative-bg)"/>
      <path class="cross cross-1" d="M20 20L36 36" stroke="var(--negative-fg)" stroke-width="3.5" stroke-linecap="round" fill="none"/>
      <path class="cross cross-2" d="M36 20L20 36" stroke="var(--negative-fg)" stroke-width="3.5" stroke-linecap="round" fill="none"/>
    </svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --surface: #F5F3EB;
      --surface-card: #FFFFFF;
      --card-border: #E8E6DA;
      --text-primary: #2A2A28;
      --text-secondary: #4A4A46;
      --positive-bg: #D4DFD0;
      --positive-fg: #516748;
      --negative-bg: #F7DAC9;
      --negative-fg: #DA491A;
      --shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06);
      --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --surface: #1A1A18;
        --surface-card: #2A2A28;
        --card-border: #3A3A37;
        --text-primary: #F5F3EB;
        --text-secondary: #BDB9A9;
        --positive-bg: #1A2316;
        --positive-fg: #7A8B6F;
        --negative-bg: #4E281D;
        --negative-fg: #E86B40;
        --shadow: 0 1px 3px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.3);
      }
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--font);
      background: var(--surface);
      color: var(--text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      text-align: center;
      padding: 48px 40px 40px;
      background: var(--surface-card);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      box-shadow: var(--shadow);
      max-width: 380px;
      width: 100%;
      opacity: 0;
      transform: translateY(8px) scale(0.98);
      animation: cardIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.1s forwards;
    }
    @keyframes cardIn {
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .icon {
      width: 56px;
      height: 56px;
      margin-bottom: 20px;
    }
    .check {
      stroke-dasharray: 32;
      stroke-dashoffset: 32;
      animation: draw 0.4s ease-out 0.45s forwards;
    }
    .cross {
      stroke-dasharray: 22;
      stroke-dashoffset: 22;
    }
    .cross-1 { animation: draw 0.3s ease-out 0.45s forwards; }
    .cross-2 { animation: draw 0.3s ease-out 0.55s forwards; }
    @keyframes draw {
      to { stroke-dashoffset: 0; }
    }
    h1 {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.2px;
      color: var(--text-primary);
      margin-bottom: 6px;
    }
    p {
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-secondary);
    }
  </style>
</head>
<body>
  <div class="card">
    ${success ? checkmarkSvg : errorSvg}
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(subtitle)}</p>
  </div>
</body>
</html>`;
}

export interface LoopbackListener {
  /** The full `http://127.0.0.1:<port>/auth/callback` redirect URI. */
  redirectUri: string;
  /** Resolves with the authorization code once the state-matched callback arrives. */
  waitForCode: Promise<string>;
  /** Tear down the server, rejecting any pending waiter with `reason`. */
  close: (reason?: string) => void;
}

/**
 * Bind an ephemeral 127.0.0.1 listener and wait for the OAuth redirect.
 * Exported for tests; production callers go through `workosPkceLogin`.
 */
export function startLoopbackListener(
  expectedState: string,
): Promise<LoopbackListener> {
  return new Promise((resolveListener, rejectListener) => {
    let settle: {
      resolve: (code: string) => void;
      reject: (err: Error) => void;
    };
    const waitForCode = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (
        url.pathname !== CALLBACK_PATH ||
        url.searchParams.get("state") !== expectedState
      ) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error || !code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          renderLoginPage(
            "Login Failed",
            "Please try again from your terminal.",
            false,
          ),
        );
        server.close();
        settle.reject(
          new Error(
            `Authentication failed: ${error ?? "no authorization code received"}`,
          ),
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        renderLoginPage(
          "Login Successful",
          "You can close this window and return to your terminal.",
          true,
        ),
      );
      server.close();
      settle.resolve(code);
    });

    server.on("error", rejectListener);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        rejectListener(new Error("Failed to start local server."));
        return;
      }
      const { port } = addr as AddressInfo;
      resolveListener({
        redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        waitForCode,
        close: (reason?: string) => {
          server.close();
          settle.reject(new Error(reason ?? "Login cancelled."));
        },
      });
    });
  });
}

/** App-held WorkOS PKCE login */
export async function workosPkceLogin(cloudUrl: string): Promise<string> {
  if (!process.stdin.isTTY) return pollingCloudLogin(cloudUrl);
  const clientId = await fetchWorkosClientId(cloudUrl);
  const { verifier, challenge } = generatePkcePair();
  const state = randomBytes(32).toString("hex");

  const listener = await startLoopbackListener(state);
  const timeout = setTimeout(() => {
    listener.close("Login timed out. Please try again.");
  }, LOGIN_TIMEOUT_MS);

  try {
    const authorizeUrl = buildAuthorizeUrl({
      clientId,
      redirectUri: listener.redirectUri,
      challenge,
      state,
    });

    console.log("Opening browser for login...");
    console.log(`If the browser doesn't open, visit: ${authorizeUrl}`);
    openBrowser(authorizeUrl);

    const code = await listener.waitForCode;
    const accessToken = await exchangeCodeWithWorkos({
      clientId,
      code,
      verifier,
    });
    return await exchangeAccessTokenForSession(
      cloudUrl,
      clientId,
      accessToken,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export interface CloudLoginSession {
  token: string;
  user: { id: string; email: string };
}

/**
 * Interactive Cadet Cloud login, reusable beyond `cadet login` (e.g. `cadet
 * hatch` when the user picks the Cadet Cloud provider). Returns the stored
 * session when one is already valid; otherwise runs the browser PKCE flow,
 * validates the resulting token, and persists it.
 */
export async function ensureCloudLoginInteractive(): Promise<CloudLoginSession> {
  const existingToken = readCloudToken();
  if (existingToken) {
    try {
      const user = await fetchCurrentUser(existingToken);
      return { token: existingToken, user };
    } catch {
      // Stale/invalid — fall through to a fresh browser login.
    }
  }

  const token = await workosPkceLogin(getCloudUrl());
  const user = await fetchCurrentUser(token);
  saveCloudToken(token);
  return { token, user };
}

/**
 * TLS failures surface as opaque messages like "unknown certificate
 * verification error" from Bun's fetch. Translate the recognizable ones into
 * something actionable — most commonly the cloud host's managed
 * certificate is still provisioning.
 */
export function describeLoginError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const tlsish = /certificate|tls|ssl|unable to verify|self-signed/i.test(raw);
  if (!tlsish) return raw;
  return (
    `Cadet Cloud is unreachable (${raw}). This usually means ` +
    `${getCloudUrl()}'s TLS certificate is missing or still provisioning. ` +
    "Retry in a few minutes, or point CADET_CLOUD_URL at a reachable host."
  );
}

/**
 * Register the active self-hosted assistant with the cloud and inject
 * cloud credentials into its runtime — the post-login half of the desktop
 * app's LocalAssistantBootstrapService flow. Extracted so `cadet hatch` can
 * complete the same flow right after an interactive login on the Cadet Cloud
 * provider path. Non-fatal by design; callers log failures.
 */
export async function registerLocalAssistantWithPlatform(
  token: string,
  user: { id: string; email: string },
  options: { bearerToken?: string; log?: (message: string) => void } = {},
): Promise<void> {
  const log = options.log ?? console.log;
  const entry = resolveAssistant();

  // Skip managed ("cadet") assistants — they are handled by the cloud.
  if (!entry || isCloudHome(entry.cloud)) return;

  const orgId = await fetchOrganizationId(token);
  const clientInstallationId = computeDeviceId();
  const [assistantVersion, ingressUrl] = await Promise.all([
    fetchCurrentVersion(entry.runtimeUrl),
    fetchAssistantIngressUrl(entry.runtimeUrl, options.bearerToken ?? entry.bearerToken),
  ]);
  const cloudUrl = getCloudUrl();
  const registration = await ensureSelfHostedLocalRegistration(
    token,
    orgId,
    clientInstallationId,
    entry.assistantId,
    "cli",
    assistantVersion,
    cloudUrl,
    ingressUrl,
  );
  saveLockfileAssistant({
    ...entry,
    cloudAssistantId: registration.assistant.id,
    cloudBaseUrl: cloudUrl,
    cloudOrganizationId: orgId,
  });
  log(
    `Registered assistant: ${registration.assistant.name} (${registration.assistant.id})`,
  );

  // Which key to hand the assistant, and why. Shared with teleport so
  // the two injection paths cannot drift.
  const resolved = await resolveAssistantApiKeyForInjection({
    registrationApiKey: registration.assistant_api_key,
    runtimeUrl: entry.runtimeUrl,
    bearerToken: options.bearerToken ?? entry.bearerToken,
    token,
    organizationId: orgId,
    clientInstallationId,
    runtimeAssistantId: entry.assistantId,
    clientPlatform: "cli",
  });
  const assistantApiKey = resolved.apiKey;
  if (resolved.source === "reprovisioned") {
    log("Provisioning a replacement API key...");
  }

  // Inject credentials into the running assistant via the gateway,
  // mirroring the desktop app's LocalAssistantBootstrapService flow.
  const allInjected = await injectCredentialsIntoAssistant({
    gatewayUrl: entry.runtimeUrl,
    bearerToken: options.bearerToken ?? entry.bearerToken,
    assistantApiKey,
    cloudAssistantId: registration.assistant.id,
    organizationId: orgId,
    userId: user.id,
    webhookSecret: registration.webhook_secret,
  });
  if (allInjected) {
    log("Injected cloud credentials into assistant.");
  } else {
    console.warn("Some credentials could not be injected into the assistant.");
  }
}
