import { describe, expect, test } from "bun:test";

import {
  formatCadetModel,
  getManagedUpstream,
  MANAGED_ROUTABLE_PROVIDERS,
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

  test("format rejects a non-managed provider", () => {
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

  test("getManagedUpstream resolves a bare catalog id to its owner", () => {
    expect(getManagedUpstream("claude-fable-5")).toBe("anthropic");
    expect(getManagedUpstream("qwen/qwen3-8b")).toBe("cadet");
  });

  test("getManagedUpstream resolves a routing string by its prefix", () => {
    expect(
      getManagedUpstream("fireworks/accounts/fireworks/models/minimax-m3"),
    ).toBe("fireworks");
  });

  test("getManagedUpstream returns null for non-managed owners", () => {
    expect(getManagedUpstream("MiniMax-M3")).toBeNull(); // minimax, not managed
    expect(getManagedUpstream("openrouter/whatever")).toBeNull();
  });

  test("getManagedUpstream returns null for unknown models", () => {
    expect(getManagedUpstream("not-a-real-model")).toBeNull();
    expect(getManagedUpstream("")).toBeNull();
  });

  test("getManagedUpstream rejects managed-prefixed strings whose model is not cataloged under that provider", () => {
    expect(getManagedUpstream("anthropic/definitely-not-a-model")).toBeNull();
    expect(getManagedUpstream("openai/accounts/foo/bar")).toBeNull();
  });

  test("managed set matches the platform proxy table", () => {
    // Guards against drift if PLATFORM_PROVIDER_META changes.
    expect([...MANAGED_ROUTABLE_PROVIDERS].sort()).toEqual([
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
