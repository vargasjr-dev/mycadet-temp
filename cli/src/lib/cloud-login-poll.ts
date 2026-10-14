import { z } from "zod";
import { loopbackSafeFetch } from "./loopback-fetch.js";

const requestSchema = z.object({
  request_id: z.string().regex(/^[a-f0-9]{64}$/),
  poll_secret: z.string().regex(/^[a-f0-9]{64}$/),
  verification_uri: z.string().url(),
  user_code: z.string().min(1),
  interval: z.number().min(1).max(10),
});
const resultSchema = z.object({ session_token: z.string().min(1) });

/** Browser approval and polling work when the terminal and browser are on different hosts. */
export async function pollingCloudLogin(
  cloudUrl: string,
  options: {
    timeoutMs?: number;
    fetch?: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>;
    log?: (message: string) => void;
  } = {},
): Promise<string> {
  const request = options.fetch ?? loopbackSafeFetch;
  const log = options.log ?? console.log;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 300_000);
  const origin = new URL(cloudUrl).origin;
  try {
    const started = await request(`${origin}/v1/auth/cli/start`, {
      method: "POST",
      signal,
    });
    if (!started.ok)
      throw new Error(`Could not start terminal login (${started.status}).`);
    const login = requestSchema.parse(await started.json());
    log(`Open this URL to log in: ${login.verification_uri}`);
    log(
      `Confirm code ${login.user_code} in your browser. Waiting up to 5 minutes...`,
    );
    while (!signal.aborted) {
      const response = await request(`${origin}/v1/auth/cli/poll`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: login.request_id,
          poll_secret: login.poll_secret,
        }),
      });
      if (response.status === 200)
        return resultSchema.parse(await response.json()).session_token;
      if (response.status === 410)
        throw new Error("Login request expired. Run cadet login again.");
      if (response.status !== 202)
        throw new Error(`Login polling failed (${response.status}).`);
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new Error("Login timed out after 5 minutes."));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, login.interval * 1000);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    throw new Error("Login timed out after 5 minutes.");
  } catch (error) {
    if (signal.aborted) throw new Error("Login timed out after 5 minutes.");
    throw error;
  }
}
