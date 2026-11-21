import { APP_HOST, APP_PROTOCOL } from "./app-config";

/**
 * The single origin the renderer legitimately runs at, expressed as a
 * structured protocol + host pair rather than a string. The renderer always
 * loads over the privileged `app://mycadet.ai` scheme (registered
 * `standard` + `secure` in `index.ts`), so a frame's `origin` is a real
 * tuple origin in every build mode.
 */
export interface AllowedOrigin {
  protocol: string;
  host: string;
}

/**
 * The one resolver for every client: the renderer's origin is a build-time
 * constant, so the guard compares against the app origin and nothing else.
 * Read at call time so the same property the navigation guard and the IPC
 * sender guard both rely on stays a single shared shape.
 */
export const resolveAllowedOrigin = (): AllowedOrigin => ({
  protocol: `${APP_PROTOCOL}:`,
  host: APP_HOST,
});

/**
 * Whether `origin` matches the build's renderer origin. Accepts either
 * a frame's `senderFrame.origin` string (the IPC sender guard) or an
 * already-parsed navigation target `URL` (the navigation guard). The
 * comparison is on the protocol + host tuple, never on `URL.origin`:
 * `app://mycadet.ai` is a non-special scheme to WHATWG URL, so its
 * `.origin` is the opaque string `"null"` - protocol + host stays
 * stable and is what Electron exposes for the `standard`-registered
 * scheme. A null/empty or unparseable origin is never allowed.
 */
export const isAllowedOrigin = (
  origin: string | URL | null | undefined,
  allowed: AllowedOrigin,
): boolean => {
  if (!origin) {
    return false;
  }
  let parsed: URL;
  if (origin instanceof URL) {
    parsed = origin;
  } else {
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
  }
  return parsed.protocol === allowed.protocol && parsed.host === allowed.host;
};
