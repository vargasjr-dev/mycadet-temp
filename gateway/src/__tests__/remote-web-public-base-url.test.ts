import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { testWorkspaceDir } from "./test-preload.js";

import {
  parsePublicBaseUrl,
  readSavedIngressPublicBaseUrl,
} from "../remote-web/public-base-url.js";

const CONFIG_PATH = join(testWorkspaceDir, "config.json");

beforeEach(() => {
  rmSync(CONFIG_PATH, { force: true });
});

afterEach(() => {
  rmSync(CONFIG_PATH, { force: true });
});

describe("readSavedIngressPublicBaseUrl — the gateway's own config read", () => {
  test("returns the saved ingress URL", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        // A full workspace config carries many other keys; the gateway's
        // minimal schema ignores everything but the little shape it reads.
        daemon: { port: 39393 },
        ingress: { enabled: true, publicBaseUrl: "https://pair.example.test" },
      }),
    );
    expect(readSavedIngressPublicBaseUrl()).toBe("https://pair.example.test");
  });

  test("answers the localhost default for every kind of absence", () => {
    // No config file at all.
    expect(readSavedIngressPublicBaseUrl()).toBe("http://127.0.0.1:7830");

    // No ingress block.
    writeFileSync(CONFIG_PATH, JSON.stringify({ daemon: { port: 39393 } }));
    expect(readSavedIngressPublicBaseUrl()).toBe("http://127.0.0.1:7830");

    // A blank saved value.
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ ingress: { publicBaseUrl: "   " } }),
    );
    expect(readSavedIngressPublicBaseUrl()).toBe("http://127.0.0.1:7830");
  });

  test("answers the localhost default when the saved shape doesn't match the schema", () => {
    // A non-string URL.
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ ingress: { publicBaseUrl: 7 } }),
    );
    expect(readSavedIngressPublicBaseUrl()).toBe("http://127.0.0.1:7830");

    // Malformed JSON.
    writeFileSync(CONFIG_PATH, "{not json");
    expect(readSavedIngressPublicBaseUrl()).toBe("http://127.0.0.1:7830");
  });
});

describe("parsePublicBaseUrl", () => {
  test("normalizes to origin plus trailing-slash-stripped path", () => {
    expect(parsePublicBaseUrl("https://pair.example.test/tunnel///")).toBe(
      "https://pair.example.test/tunnel",
    );
  });

  test("rejects non-http(s), hostless, and unparseable values", () => {
    expect(parsePublicBaseUrl("ftp://pair.example.test")).toBeNull();
    expect(parsePublicBaseUrl("https://")).toBeNull();
    expect(parsePublicBaseUrl("not a url")).toBeNull();
  });
});
