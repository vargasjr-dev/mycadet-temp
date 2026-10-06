/// <reference types="vite/client" />

/**
 * Build-time environment variables exposed to the client bundle.
 *
 * All `VITE_*` vars are public and embedded in the JS bundle at build time.
 * Server-only values (API keys, auth tokens) use unprefixed names and are
 * NOT available here — they remain in `process.env` during CI/CD only.
 *
 * Reference: https://vite.dev/guide/env-and-mode#intellisense-for-typescript
 */
interface ImportMetaEnv {
  /** Session-replay environment tag (e.g. "production", "staging"). */
  readonly VITE_SESSION_REPLAY_ENVIRONMENT?: string;
  /**
   * Session-replay app ID. A single ID across all hosts (web / Electron / iOS):
   * replay records the web DOM, so one project covers every surface and the host
   * is distinguished by a `surface` trait. Unset → session replay disabled.
   */
  readonly VITE_SESSION_REPLAY_APP_ID?: string;
  /**
   * Root hostname shared across Vellum subdomains, with a leading dot (e.g.
   * `.vellum.ai`). Used as the session-replay cookie scope (`rootHostname`).
   * Defaults to `.vellum.ai` when unset. The Electron main process reads the
   * same var via `process.env` at build time (see `electron.vite.config.ts`).
   */
  readonly VITE_ROOT_HOSTNAME?: string;
  /** Stripe publishable key for payment forms. Injected by CI/CD pipeline. */
  readonly VITE_STRIPE_PUBLISHABLE_KEY?: string;
  /** App version stamp for diagnostic reporting. */
  readonly VITE_APP_VERSION?: string;
  /** Release channel this bundle was built as. `"preview"` or stable otherwise. */
  readonly VITE_CHANNEL?: string;
  /** When set, the app runs in platform (cloud-hosted) mode. Unset = local mode. */
  readonly VITE_PLATFORM_MODE?: string;
  /** When truthy ("1", "true", "yes"), disables platform connectivity in local mode. */
  readonly VITE_VELLUM_DISABLE_PLATFORM?: string;
  /**
   * Live Google Play listing for ai.vellum.assistant. Android install
   * promotion remains hidden when this is unset or invalid.
   */
  readonly VITE_ANDROID_PLAY_STORE_URL?: string;
  /**
   * Override for the live-voice tunnel host (no scheme), e.g. `localhost:8501`
   * for a local `vel up` tunnel. When unset the host is derived at runtime from
   * the platform host (`tunnel.mycadet.ai`, `tunnel-{env}.vellum.ai`). See
   * `domains/chat/voice/live-voice/connection.ts`.
   */
  readonly VITE_TUNNEL_HOST?: string;

  /** Feature flag overrides via env vars: `VITE_VELLUM_FLAG_<UPPER_SNAKE_KEY>=true|false|string`. */
  readonly [key: `VITE_VELLUM_FLAG_${string}`]: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  /** Feature flag overrides injected by Electron preload or CLI script. */
  __VELLUM_FLAG_OVERRIDES__?: Record<string, boolean | string>;
  /** Runtime config injected by the shell (Electron preload, CLI, etc.). */
  __VELLUM_CONFIG__?: {
    disablePlatform?: boolean;
    mode?: string;
    platformUrl?: string;
    /** Serving assistant's display name (remote-web ingress configs only). */
    assistantName?: string;
    /** Serving assistant's id (remote-web ingress configs only). */
    assistantId?: string;
    /** Cloud web SPA base for this build's environment (remote-web ingress configs only). */
    hubUrl?: string;
  };
  /**
   * SDK-defined override for the session-replay recorder script URL. Set before
   * the replay SDK inits so it loads the recorder from our first-party proxy
   * (see `session-replay-provider.ts`).
   */
  _lrAsyncScript?: string;
  /**
   * SDK-defined config object the session-replay recorder reads at boot. We set
   * `statsURL` on it to route the stats beacon through our first-party proxy —
   * the data endpoint has an init option but the beacon does not.
   */
  __SDKCONFIG__?: { statsURL?: string; serverURL?: string };
}
