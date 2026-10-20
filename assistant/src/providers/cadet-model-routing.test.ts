import { describe, expect, test } from "bun:test";

import {
  CLOUD_ROUTABLE_PROVIDERS,
  formatCadetModel,
  getCloudUpstream,
  parseCadetModel,
} from "./cadet-model-routing.js";

describe("cadet-model-routing", () => {
  test("round-trips a slashy native Fireworks id losslessly", () => {
    const native = "accounts/fireworks/models/minimax-m3";
    const encoded = formatCadetModel("fireworks", native);
    expect(encoded).toBe("fireworks/accounts/fireworks/models/minimax-m3");
    expect(parseCadetModel(encoded)).toEqual({
      provider: "fireworks",
      model: native,
    });
  });

  test("round-trips a bare Anthropic id", () => {
    const encoded = formatCadetModel("anthropic", "claude-fable-5");
    expect(parseCadetModel(encoded)).toEqual({
      provider: "anthropic",
      model: "claude-fable-5",
    });
  });

  test("format rejects a non-cloud provider", () => {
    expect(() => formatCadetModel("openrouter", "x")).toThrow();
    expect(() => formatCadetModel("fireworks", "")).toThrow();
  });

  test("parse returns null for non-routed strings", () => {
    expect(parseCadetModel("claude-opus-4-8")).toBeNull(); // no slash
    expect(parseCadetModel("openrouter/whatever")).toBeNull(); // not managed
    expect(parseCadetModel("minimax/minimax-m3")).toBeNull(); // not managed
    expect(parseCadetModel("fireworks/")).toBeNull(); // empty model
    expect(parseCadetModel("/foo")).toBeNull(); // empty provider
  });

  test("getCloudUpstream resolves a bare catalog id to its owner", () => {
    expect(getCloudUpstream("claude-fable-5")).toBe("anthropic");
    // The cadet catalog's model id is fireworks-shaped, so the shared id
    // resolves to its first catalog owner and the cadet prefix pins cadet.
    expect(getCloudUpstream("accounts/fireworks/models/glm-5p3-flash")).toBe(
      "fireworks",
    );
    expect(getCloudUpstream("cadet/accounts/fireworks/models/glm-5p3-flash")).toBe(
      "cadet",
    );
  });

  test("getCloudUpstream resolves a routing string by its prefix", () => {
    expect(
      getCloudUpstream("fireworks/accounts/fireworks/models/minimax-m3"),
    ).toBe("fireworks");
  });

  test("getCloudUpstream returns null for non-managed owners", () => {
    expect(getCloudUpstream("MiniMax-M3")).toBeNull(); // minimax, not managed
    expect(getCloudUpstream("openrouter/whatever")).toBeNull();
  });

  test("getCloudUpstream returns null for unknown models", () => {
    expect(getCloudUpstream("not-a-real-model")).toBeNull();
    expect(getCloudUpstream("")).toBeNull();
  });

  test("getCloudUpstream rejects managed-prefixed strings whose model is not cataloged under that provider", () => {
    expect(getCloudUpstream("anthropic/definitely-not-a-model")).toBeNull();
    expect(getCloudUpstream("openai/accounts/foo/bar")).toBeNull();
  });

  test("managed set matches the cloud proxy table", () => {
    // Guards against drift if PLATFORM_PROVIDER_META changes.
    expect([...CLOUD_ROUTABLE_PROVIDERS].sort()).toEqual([
      "anthropic",
      "cadet",
      "fireworks",
      "gemini",
      "openai",
      "together",
      "typesafe",
    ]);
  });
});
