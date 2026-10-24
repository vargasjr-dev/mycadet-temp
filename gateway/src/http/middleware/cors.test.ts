import { describe, expect, test } from "bun:test";

import { corsHeaders, handlePreflight, resolveWebviewOrigin } from "./cors.js";

function requestWithOrigin(origin: string | null): Request {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  return new Request("http://127.0.0.1:7830/v1/assistants/", { headers });
}

describe("resolveWebviewOrigin", () => {
  test("accepts the embedded macOS webview origins", () => {
    expect(
      resolveWebviewOrigin(requestWithOrigin("https://app.cadet.local")),
    ).toBe("https://app.cadet.local");
  });

  test("accepts the Capacitor shells' own webview origins", () => {
    // The mobile shells serve the bundled app from their local scheme and
    // call the daemon through a tunnel — cross-origin like the macOS
    // webview. A browser never emits a custom-scheme Origin, so only the
    // shells themselves can produce these.
    expect(
      resolveWebviewOrigin(requestWithOrigin("capacitor://localhost")),
    ).toBe("capacitor://localhost");
    expect(resolveWebviewOrigin(requestWithOrigin("https://localhost"))).toBe(
      "https://localhost",
    );
    expect(resolveWebviewOrigin(requestWithOrigin("http://localhost"))).toBe(
      "http://localhost",
    );
  });

  test("rejects origins outside the shell families", () => {
    expect(
      resolveWebviewOrigin(requestWithOrigin("https://evil.example")),
    ).toBeNull();
    expect(
      resolveWebviewOrigin(requestWithOrigin("capacitor://evil.example")),
    ).toBeNull();
    expect(resolveWebviewOrigin(requestWithOrigin(null))).toBeNull();
  });
});

describe("corsHeaders", () => {
  test("reflects the origin and allows credentials", () => {
    // A reflected origin (never a wildcard) is what credentials-mode fetches
    // require — `Access-Control-Allow-Origin: *` is ignored for them.
    const headers = corsHeaders("capacitor://localhost");
    expect(headers["Access-Control-Allow-Origin"]).toBe(
      "capacitor://localhost",
    );
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
  });

  test("answers a preflight with the allowed methods and headers", () => {
    const preflight = handlePreflight("https://localhost");
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://localhost",
    );
    expect(preflight.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
  });
});
