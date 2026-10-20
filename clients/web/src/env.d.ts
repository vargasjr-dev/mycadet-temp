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
declare global {
  interface ImportMetaEnv {
    /** Stripe publishable key for payment forms. Injected by CI/CD pipeline. */
    readonly VITE_STRIPE_PUBLISHABLE_KEY?: string;
    /** App version stamp for diagnostic reporting. */
    readonly VITE_APP_VERSION?: string;
    /** Release channel this bundle was built as. `"preview"` or stable otherwise. */
    readonly VITE_CHANNEL?: string;
    /** When set, the app runs in platform (cloud-hosted) mode. Unset = local mode. */
    /** When truthy ("1", "true", "yes"), disables platform connectivity in local mode. */
    readonly VITE_CADET_DISABLE_CLOUD?: string;
    /**
     * Live Google Play listing for ai.mycadet.android. Android install
     * promotion remains hidden when this is unset or invalid.
     */
    readonly VITE_ANDROID_PLAY_STORE_URL?: string;
    /**
     * Override for the live-voice tunnel host (no scheme), e.g. `localhost:8501`
     * for a local `vel up` tunnel. When unset the host is derived at runtime from
     * the cloud host (`tunnel.mycadet.ai`, `tunnel-{env}.mycadet.ai`). See
     * `domains/chat/voice/live-voice/connection.ts`.
     */
    readonly VITE_TUNNEL_HOST?: string;

    /** Feature flag overrides via env vars: `VITE_CADET_FLAG_<UPPER_SNAKE_KEY>=true|false|string`. */
    readonly [key: `VITE_CADET_FLAG_${string}`]: string | undefined;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    /** Feature flag overrides injected by Electron preload or CLI script. */
    __CADET_FLAG_OVERRIDES__?: Record<string, boolean | string>;
    /** Runtime config injected by the shell (Electron preload, CLI, etc.). */
    /** Raw host-injected config; `readInjectedConfig` is the parse boundary. */
    __CADET_CONFIG__?: unknown;
  }
}

export {};
