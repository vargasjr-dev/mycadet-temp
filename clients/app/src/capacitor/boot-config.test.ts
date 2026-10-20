import { afterEach, describe, expect, test } from "bun:test";
import baseConfig from "../../capacitor.config.base";
import {
  bootConfigScript,
  capacitorBootConfig,
  readCapacitorBootConfig,
} from "./boot-config";

describe("capacitorBootConfig", () => {
  test("local environment hands off to the same-origin baked web bundle", () => {
    expect(capacitorBootConfig({})).toEqual({
      remote: "local",
      handoffUrl: "/assistant/",
    });
  });

  test("cloud environments hand off to their hub assistant entry", () => {
    expect(capacitorBootConfig({ CADET_ENVIRONMENT: "production" })).toEqual({
      remote: "cloud",
      handoffUrl: "https://mycadet.ai/assistant",
    });
    expect(capacitorBootConfig({ CADET_ENVIRONMENT: "staging" })).toEqual({
      remote: "cloud",
      handoffUrl: "https://staging.mycadet.ai/assistant",
    });
    expect(capacitorBootConfig({ CADET_ENVIRONMENT: "dev" })).toEqual({
      remote: "cloud",
      handoffUrl: "https://dev.mycadet.ai/assistant",
    });
  });

  test("CADET_SERVER_URL overrides verbatim as a custom remote", () => {
    expect(
      capacitorBootConfig({
        CADET_ENVIRONMENT: "production",
        CADET_SERVER_URL: "https://assistant.example.com",
      }),
    ).toEqual({
      remote: "custom",
      handoffUrl: "https://assistant.example.com",
    });
  });

  test("CADET_SERVER_URL must parse and use https", () => {
    expect(() =>
      capacitorBootConfig({ CADET_SERVER_URL: "not a url" }),
    ).toThrow(/not a valid URL/);
    expect(() =>
      capacitorBootConfig({ CADET_SERVER_URL: "http://assistant.example.com" }),
    ).toThrow(/must use https/);
  });
});

describe("bootConfigScript", () => {
  test("the payload carries no raw < so tag breakout is impossible", () => {
    const script = bootConfigScript({
      remote: "custom",
      handoffUrl:
        "https://assistant.example.com/?a=</script><script>alert(1)</script>",
    });
    const payload = script.slice(
      "<script>window.__CADET_CONFIG__=".length,
      -"</script>".length,
    );
    expect(payload.includes("<")).toBe(false);
    expect(JSON.parse(payload)).toEqual({
      remote: "custom",
      handoffUrl:
        "https://assistant.example.com/?a=\u003c/script\u003e\u003cscript\u003ealert(1)\u003c/script\u003e",
    });
  });
});

describe("readCapacitorBootConfig", () => {
  const setWindow = (config: unknown) => {
    (globalThis as unknown as { window: unknown }).window = {
      __CADET_CONFIG__: config,
    };
  };
  const clearWindow = () => {
    delete (globalThis as unknown as { window?: unknown }).window;
  };

  afterEach(clearWindow);

  test("returns the parsed config when the stamp matches", () => {
    setWindow({
      remote: "cloud",
      handoffUrl: "https://mycadet.ai/assistant",
    });
    expect(readCapacitorBootConfig()).toEqual({
      remote: "cloud",
      handoffUrl: "https://mycadet.ai/assistant",
    });
  });

  test("reads as undefined when nothing is stamped (SSR / absent)", () => {
    clearWindow();
    expect(readCapacitorBootConfig()).toBeUndefined();
    setWindow(undefined);
    expect(readCapacitorBootConfig()).toBeUndefined();
  });

  test("reads as undefined when a competing shape is stamped", () => {
    setWindow({
      webUrl: "http://localhost:3000",
      cloudUrl: "http://localhost:8000",
    });
    expect(readCapacitorBootConfig()).toBeUndefined();
  });
});

describe("baseConfig", () => {
  test("allowNavigation carries the same handoff host the boot stamp resolves", () => {
    // The base config resolves at cap-sync time, the stamp at build time;
    // both must agree or the handoff navigation opens the system browser.
    // The local handoff is the same-origin baked bundle — no foreign host to
    // allow — so only an absolute handoff pins an entry.
    const stamped = capacitorBootConfig({
      CADET_ENVIRONMENT: process.env.CADET_ENVIRONMENT,
      CADET_SERVER_URL: process.env.CADET_SERVER_URL,
    }).handoffUrl;
    if (!stamped.startsWith("/")) {
      expect(baseConfig.server?.allowNavigation).toEqual([
        new URL(stamped).hostname,
      ]);
    }
  });

  test("only a CADET_SERVER_URL override produces a cross-origin handoff", () => {
    expect(
      capacitorBootConfig({ CADET_SERVER_URL: "https://assistant.example.com" })
        .handoffUrl,
    ).toBe("https://assistant.example.com");
    expect(capacitorBootConfig({}).handoffUrl.startsWith("/")).toBe(true);
  });
});
