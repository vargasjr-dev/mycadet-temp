import { SEEDS } from "@mycadet/environments/seeds";
import {
  InjectedConfigSchema,
  type InjectedConfig,
} from "@app/lib/injected-config";
import { resolveLocalServerUrl } from "@mycadet/local-mode/contract";

/**
 * The build-time config the mobile shells bake into `dist/capacitor/index.html`
 * as `window.__CADET_CONFIG__` — the same shape `readInjectedConfig()` reads
 * back, with `baseUrl` resolving the stack the simulator should dial.
 */
export function capacitorInjectedConfig(): InjectedConfig {
  process.env.CADET_ENVIRONMENT ??= "local";
  const environment = process.env.CADET_ENVIRONMENT;
  if (environment === "local") {
    // The local backend is a full control plane — the web dev server
    // proxies /v1 at it — so the simulator reaches the same stack every
    // other local surface uses.
    const resolved = resolveLocalServerUrl();
    if (!resolved) {
      console.warn(
        `[capacitor] no local server resolved from the lockfile (no tunnel record, no app edge port) — the stamp falls back to ${SEEDS.local.cloudUrl}. Start \`cadet-local app start\` (or \`cadet-local tunnel start\` for a device build) before building so the shell dials the real stack.`,
      );
    }
    return InjectedConfigSchema.parse({
      remote: "local",
      baseUrl: resolved ?? SEEDS.local.cloudUrl,
    });
  }
  const seed = SEEDS[environment] ?? SEEDS.dev;
  return InjectedConfigSchema.parse({
    remote: "cloud",
    baseUrl: seed.webUrl,
  });
}

/**
 * The inline script tag carrying the config. Injected before `</head>`,
 * ahead of the deferred module bundle, so the config exists before any
 * reader runs. The payload escapes `<` so a hostile config value can't close
 * the tag and break out (`</script>` becomes `\u003c/script>`) — the same
 * mitigation the CLI's `buildRemoteWebIndexHtml` applies to its own stamps.
 */
export function injectedConfigScript(): string {
  const config = capacitorInjectedConfig();
  return `<script>window.__CADET_CONFIG__=${JSON.stringify(config).replaceAll("<", "\\u003c")}</script>`;
}
