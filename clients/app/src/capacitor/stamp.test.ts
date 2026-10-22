import { afterEach, describe, expect, test } from "bun:test";
import { capacitorInjectedConfig, injectedConfigScript } from "./stamp";

describe("capacitorInjectedConfig", () => {
  test("local environment stamps the local backend as the control plane", () => {
    expect(capacitorInjectedConfig({})).toEqual({
      remote: "local",
      cloudUrl: "http://localhost:8000",
    });
  });

  test("a resolved local server base overrides the seed default", () => {
    // The build's lockfile read: the running cadet's tunnel URL, or its
    // loopback app-server port (simulator-only — a device's 127.0.0.1 is
    // the phone).
    expect(
      capacitorInjectedConfig({}, { localServerUrl: "https://tunnel.example.net" }),
    ).toEqual({
      remote: "local",
      cloudUrl: "https://tunnel.example.net",
    });
    expect(
      capacitorInjectedConfig(
        { CADET_ENVIRONMENT: "local" },
        { localServerUrl: "http://127.0.0.1:7821" },
      ),
    ).toEqual({
      remote: "local",
      cloudUrl: "http://127.0.0.1:7821",
    });
  });

  test("cloud environments stamp their web origin — the /v1 edge", () => {
    expect(
      capacitorInjectedConfig({ CADET_ENVIRONMENT: "production" }),
    ).toEqual({
      remote: "cloud",
      cloudUrl: "https://mycadet.ai",
    });
    expect(capacitorInjectedConfig({ CADET_ENVIRONMENT: "staging" })).toEqual({
      remote: "cloud",
      cloudUrl: "https://staging.mycadet.ai",
    });
    expect(capacitorInjectedConfig({ CADET_ENVIRONMENT: "dev" })).toEqual({
      remote: "cloud",
      cloudUrl: "https://dev.mycadet.ai",
    });
  });

  test("CADET_SERVER_URL overrides verbatim as a custom remote", () => {
    expect(
      capacitorInjectedConfig({
        CADET_ENVIRONMENT: "production",
        CADET_SERVER_URL: "https://assistant.example.com",
      }),
    ).toEqual({
      remote: "custom",
      cloudUrl: "https://assistant.example.com",
    });
  });

  test("CADET_SERVER_URL must parse and use https", () => {
    expect(() =>
      capacitorInjectedConfig({ CADET_SERVER_URL: "not a url" }),
    ).toThrow(/not a valid URL/);
    expect(() =>
      capacitorInjectedConfig({
        CADET_SERVER_URL: "http://assistant.example.com",
      }),
    ).toThrow(/must use https/);
  });
});

describe("injectedConfigScript", () => {
  test("the payload carries no raw < so tag breakout is impossible", () => {
    const script = injectedConfigScript({
      remote: "custom",
      cloudUrl:
        "https://assistant.example.com/?a=</script><script>alert(1)</script>",
    });
    const payload = script.slice(
      "<script>window.__CADET_CONFIG__=".length,
      -"</script>".length,
    );
    expect(payload.includes("<")).toBe(false);
    expect(JSON.parse(payload)).toEqual({
      remote: "custom",
      cloudUrl:
        "https://assistant.example.com/?a=\u003c/script\u003e\u003cscript\u003ealert(1)\u003c/script\u003e",
    });
  });
});
