/**
 * App-held PKCE login against WorkOS User Management (RFC 8252 loopback).
 */

import crypto from "node:crypto";

import { z } from "zod";
import { loopbackSafeFetch } from "@mycadet/local-mode";

const WORKOS_API_BASE_URL = "https://api.workos.com";
const PROVIDER_ID = "workos";
const SCOPE = "openid profile email";

// Use a loopback callback: `http://127.0.0.1:*/auth/callback`
export const CALLBACK_PATH = "/auth/callback";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkcePair(): PkcePair {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

export interface AuthorizeUrlOptions {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  loginHint?: string;
}

export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const url = new URL("/user_management/authorize", WORKOS_API_BASE_URL);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", options.state);
  // No `prompt`: lets the browser's existing IdP session be reused.
  url.searchParams.set("provider", "authkit");
  if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);
  return url.toString();
}

const HeadlessProviderEntrySchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  client_id: z.string().optional(),
  flows: z.array(z.string()).optional(),
  openid_configuration_url: z.string().optional(),
});

type HeadlessProviderEntry = z.infer<typeof HeadlessProviderEntrySchema>;

const WorkosAuthConfigSchema = z.object({
  data: z
    .object({
      socialaccount: z
        .object({
          providers: z.array(HeadlessProviderEntrySchema).optional(),
        })
        .optional(),
    })
    .optional(),
});

const WorkosAccessTokenResponseSchema = z.object({
  access_token: z.string(),
});

const WorkosSessionTokenResponseSchema = z.object({
  meta: z
    .object({
      session_token: z.string(),
    })
    .optional(),
});

/**
 * Pick the OAuth2 WorkOS provider from the headless config. During the
 * coexistence window two entries share the "workos-oidc" id; the usable one
 * has token auth and no OIDC discovery URL. Null if none.
 */
export function selectWorkosClientId(
  providers: HeadlessProviderEntry[],
): string | null {
  const entry = providers.find(
    (p) =>
      !p.openid_configuration_url &&
      (p.flows ?? []).includes("provider_token") &&
      typeof p.client_id === "string",
  );
  return entry?.client_id ?? null;
}

export async function fetchWorkosClientId(cloudUrl: string): Promise<string> {
  const url = `${new URL(cloudUrl).origin}/_allauth/app/v1/config`;
  const response = await loopbackSafeFetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch auth config (${response.status})`);
  }
  const parsed = WorkosAuthConfigSchema.safeParse(await response.json());
  const providers = parsed.success
    ? (parsed.data.data?.socialaccount?.providers ?? [])
    : [];
  const clientId = selectWorkosClientId(providers);
  if (!clientId) {
    throw new Error(
      "Cadet Cloud does not advertise a token-auth WorkOS provider; cannot start PKCE login.",
    );
  }
  return clientId;
}

/** Exchange the authorization code at WorkOS as a public client. */
export async function exchangeCodeWithWorkos(options: {
  clientId: string;
  code: string;
  verifier: string;
}): Promise<string> {
  const response = await loopbackSafeFetch(
    `${WORKOS_API_BASE_URL}/user_management/authenticate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: options.clientId,
        grant_type: "authorization_code",
        code: options.code,
        code_verifier: options.verifier,
      }),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `WorkOS code exchange failed (${response.status}): ${body}`,
    );
  }
  const parsed = WorkosAccessTokenResponseSchema.safeParse(
    await response.json(),
  );
  if (!parsed.success) {
    throw new Error("WorkOS code exchange returned no access token.");
  }
  return parsed.data.access_token;
}

/** Exchange the WorkOS access token for a cloud session token. */
export async function exchangeAccessTokenForSession(
  cloudUrl: string,
  clientId: string,
  accessToken: string,
): Promise<string> {
  const url = `${new URL(cloudUrl).origin}/_allauth/app/v1/auth/provider/token`;
  const response = await loopbackSafeFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: PROVIDER_ID,
      process: "login",
      token: { client_id: clientId, access_token: accessToken },
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Session exchange failed (${response.status}): ${body}`);
  }
  const parsed = WorkosSessionTokenResponseSchema.safeParse(
    await response.json(),
  );
  const sessionToken = parsed.success
    ? parsed.data.meta?.session_token
    : undefined;
  if (!sessionToken) {
    throw new Error("Session exchange returned no session token.");
  }
  return sessionToken;
}
