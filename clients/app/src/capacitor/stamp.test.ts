import { afterEach, describe, expect, test } from "bun:test";
import { capacitorInjectedConfig, injectedConfigScript } from "./stamp";

describe("capacitorInjectedConfig", () => {
  test("local environment stamps the bare local remote", () => {
    expect(capacitorInjectedConfig({})).toEqual({ remote: "local" });
  });

  test("cloud environments stamp their platform API origin", () => {
    expect(
      capacitorInjectedConfig({ CADET_ENVIRONMENT: "production" }),
    ).toEqual({ remote: "cloud", cloudUrl: "https://cloud.mycadet.ai" });
    expect(capacitorInjectedConfig({ CADET_ENVIRONMENT: "staging" })).toEqual({
      remote: "cloud",
      cloudUrl: "https://staging-cloud.mycadet.ai",
    });
    expect(capacitorInjectedConfig({ CADET_ENVIRONMENT: "dev" })).toEqual({
      remote: "cloud",
      cloudUrl: "https://dev-cloud.mycadet.ai",
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
