import { beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("../feature-flag-resolver.js", () => ({
  isFeatureFlagEnabled: () => false,
}));

const {
  TUNNEL_ALLOWED_PATHS_HEADER,
  TUNNEL_STATIC_ALLOWED_PATHS,
  buildTunnelAllowedPathsHeaderValue,
} = await import("./allowed-paths.js");
// Imported after the mock is installed, and dynamically for the same reason the
// module above is, so the bridge reads the same flag resolver these tests drive.
const { isAllowedTunnelWebSocketPath, TUNNEL_ALLOWED_WEBSOCKET_EXACT_PATHS } =
  await import("./bridge-utils.js");

function decode(headerValue: string): string[] {
  return JSON.parse(headerValue) as string[];
}

describe("the tunnel registration allowlist header", () => {
  it("matches the cloud-side header name (must stay in sync with mycadet-platform RegistrationAllowedPathsHeader)", () => {
    expect(TUNNEL_ALLOWED_PATHS_HEADER).toBe("X-Cadet-Tunnel-Allowed-Paths");
  });

  it("contains only RE2-portable regex patterns (no JS-specific lookaround / backreferences) that compile in JavaScript too", () => {
    // We can't run Go RE2 here, but every pattern below is plain anchored
    // prefix/exact matching that's a strict subset of both engines.
    const patterns = [
      ...TUNNEL_STATIC_ALLOWED_PATHS,
      ...decode(
        buildTunnelAllowedPathsHeaderValue(() => [
          "/webhooks/plugins/example/realtime",
          "/webhooks/plugins/ex.am+ple/(realtime)",
        ]),
      ),
    ];
    for (const pattern of patterns) {
      expect(() => new RegExp(pattern)).not.toThrow();
      // RE2-incompatible features that should never appear: lookahead,
      // lookbehind, backreferences. A simple guard is enough — the cloud
      // side will reject anything Go's regexp.Compile can't parse.
      expect(pattern).not.toMatch(/\(\?[=!<]/); // lookaround
      expect(pattern).not.toMatch(/\\[1-9]/); // backreferences
    }
  });

  it("matches the gateway public-surface route shapes", () => {
    // Allowlist coverage check — if you add a public route in
    // `gateway/src/index.ts` that needs to be reachable through the Tunnel
    // tunnel, add a matching regex to TUNNEL_STATIC_ALLOWED_PATHS (or, for a
    // webhook path, register it) and a sample here.
    const samples = {
      "/webhooks/telegram": true,
      "/webhooks/twilio/voice": true,
      "/webhooks/twilio/status": true,
      "/webhooks/twilio/voice-verify": true,
      "/webhooks/whatsapp": true,
      "/webhooks/email": true,
      "/webhooks/resend": true,
      "/webhooks/mailgun": true,
      "/webhooks/oauth/callback": true,
      // Plugin-declared webhooks ride the exact rules their registration
      // adds. Which of them the gateway actually serves is decided by the
      // approval gate, not by Tunnel — the tunnel just stops treating the
      // prefix as private.
      "/webhooks/plugins/example/realtime": true,
      "/v1/audio/some-uuid.mp3": true,
      "/v1/live-voice": true,
      "/v1/stt/stream": true,
      // Watch sessions on a cloud assistant ride the tunnel, the same shape
      // as live voice: tunnel validates the browser's minted token on this path
      // and injects the attested caller, and the gateway's handler admits only
      // the guardian on it. Self-hosted assistants bypass tunnel entirely.
      "/v1/watch/stream": true,
      // The assistant desktop rides the tunnel the same way: a guardian-only RFB
      // byte pipe the web client dials with a tunnel-minted token.
      "/v1/desktop/stream": true,
      "/assistant/credentials/enter": true,
      "/v1/credential-requests/peek": true,
      "/v1/credential-requests/submit": true,
      "/oauth/client-metadata.json": true,
      // Negative samples — paths that must NOT be tunnel-public.
      "/v1/credential-requests": false,
      "/v1/credential-requests/other": false,
      "/assistant/credentials": false,
      "/assistant/settings/credentials": false,
      "/oauth/client-metadata": false,
      "/v1/contacts/abc": false,
      "/v1/health": false,
      "/v1/pair": false,
      "/v1/guardian/init": false,
      "/internal/admin": false,
      "/secret": false,
      "": false,
    };
    const rules = [
      ...TUNNEL_STATIC_ALLOWED_PATHS,
      ...decode(
        buildTunnelAllowedPathsHeaderValue(() => [
          "/webhooks/telegram",
          "/webhooks/whatsapp",
          "/webhooks/email",
          "/webhooks/resend",
          "/webhooks/mailgun",
          "/webhooks/oauth/callback",
          "/webhooks/plugins/example/realtime",
        ]),
      ),
    ];
    const compiled = rules.map((p) => new RegExp(p));
    for (const [path, expected] of Object.entries(samples)) {
      const matched = compiled.some((re) => re.test(path));
      expect({ path, matched }).toEqual({ path, matched: expected });
    }
  });
});

/**
 * The two allowlists a tunnelled WebSocket has to clear, checked against each
 * other.
 *
 * The narrowed registration rules are declared to tunnel at registration and
 * enforced platform-side; `TUNNEL_ALLOWED_WEBSOCKET_EXACT_PATHS` in `bridge-utils.ts` is
 * the local second layer, enforced when the bridge dials the gateway's own
 * loopback listener. A route needs both, and their comments have always said
 * to keep them in sync, but nothing checked it.
 *
 * That gap is not theoretical: `/v1/watch/stream` was added to the
 * registration list alone, and every managed watch session died at the bridge.
 * The bridge answers a path it does not recognize with a `websocket_open_error`
 * frame and no log, tunnel reports it as an opaque `tunnel_error`, and the
 * gateway records nothing at all — so the one place the omission could have
 * been noticed was a test like this one.
 */
describe("the registration allowlist and the bridge's WebSocket allowlist", () => {
  const compiled = () => TUNNEL_STATIC_ALLOWED_PATHS.map((p) => new RegExp(p));

  /**
   * Every tunnelled WebSocket route, curated rather than derived.
   *
   * There is no single source to derive it from: the registration list is
   * RE2 regex strings tunnel compiles platform-side, and the bridge's is exact
   * paths sharing a predicate with the HTTP prefixes. Nothing in either
   * records which entries are WebSocket routes, so that fact lives here.
   *
   * Which leaves one hole this file cannot close by itself: a new WebSocket
   * route added to both allowlists but not to this list is simply unchecked.
   * If you are adding one, add it here too.
   */
  const WEBSOCKET_ROUTES = [
    "/v1/live-voice",
    "/v1/stt/stream",
    "/v1/watch/stream",
    "/v1/desktop/stream",
  ];

  it("admits every tunnelled WebSocket route at both layers", () => {
    for (const path of WEBSOCKET_ROUTES) {
      expect({
        path,
        registration: compiled().some((re) => re.test(path)),
        bridge: isAllowedTunnelWebSocketPath(path),
      }).toEqual({ path, registration: true, bridge: true });
    }
  });

  it("admits nothing at the bridge that tunnel would refuse anyway", () => {
    // Derived from the bridge's own list rather than curated, so this half
    // needs no maintenance. The reverse omission is quieter than the one
    // above: the bridge would dial happily and tunnel would 404 the upgrade
    // before the frame ever reached it.
    for (const path of TUNNEL_ALLOWED_WEBSOCKET_EXACT_PATHS) {
      expect({
        path,
        registration: compiled().some((re) => re.test(path)),
      }).toEqual({ path, registration: true });
    }
  });

  it("admits no near miss of a tunnelled route at either layer", () => {
    for (const path of [
      "/v1/watch",
      "/v1/watch/stream/extra",
      "/v1/desktop",
      "/v1/desktop/stream/extra",
      "/v1/speech",
    ]) {
      expect({
        path,
        registration: compiled().some((re) => re.test(path)),
        bridge: isAllowedTunnelWebSocketPath(path),
      }).toEqual({ path, registration: false, bridge: false });
    }
  });
});

describe("buildTunnelAllowedPathsHeaderValue", () => {
  it("drops the webhook wildcard for the statics plus one exact rule per registered path", () => {
    const rules = decode(
      buildTunnelAllowedPathsHeaderValue(() => [
        "/webhooks/telegram",
        "/webhooks/plugins/example/realtime",
      ]),
    );

    expect(rules).toEqual([
      ...TUNNEL_STATIC_ALLOWED_PATHS,
      "^/webhooks/telegram$",
      "^/webhooks/plugins/example/realtime$",
    ]);
    expect(rules).not.toContain("^/webhooks/");
    // The Twilio subtree keeps its prefix rule because its paths carry call
    // state the registry cannot hold.
    expect(rules).toContain("^/webhooks/twilio/");
  });

  it("advertises only the statics when nothing is registered", () => {
    expect(decode(buildTunnelAllowedPathsHeaderValue(() => []))).toEqual([
      ...TUNNEL_STATIC_ALLOWED_PATHS,
    ]);
  });

  it("escapes regex metacharacters so a generated rule matches only its own path", () => {
    const path = "/webhooks/plugins/a.b+c*d?e|f(g)h[i]j{k}^l$m\\n";

    const rules = decode(buildTunnelAllowedPathsHeaderValue(() => [path]));
    const generated = rules[rules.length - 1];
    const compiled = new RegExp(generated);

    expect(compiled.test(path)).toBe(true);
    expect(compiled.test("/webhooks/plugins/aXbXcXdXeXfXgXhXiXjXkXlXmXn")).toBe(
      false,
    );
    expect(compiled.test(`${path}/extra`)).toBe(false);
    expect(compiled.test(`/prefix${path}`)).toBe(false);
  });
});
