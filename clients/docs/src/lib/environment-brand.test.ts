import { afterEach, expect, test } from "bun:test";
import { brandEnvironment, logoSrc } from "./environment-brand.js";

// The serving deployment declares its environment via the shared
// `CADET_ENVIRONMENT` var; anything unset or unknown reads as
// production, which keeps the suffix-less mark.

const ORIGINAL = process.env.CADET_ENVIRONMENT;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.CADET_ENVIRONMENT;
  } else {
    process.env.CADET_ENVIRONMENT = ORIGINAL;
  }
});

test("unset reads as production with the suffix-less mark", () => {
  delete process.env.CADET_ENVIRONMENT;
  expect(brandEnvironment()).toBe("production");
  expect(logoSrc()).toBe("/docs/cadet-logo.svg");
});

test("each declared environment names itself and suffixes its mark", () => {
  for (const env of ["staging", "test", "dev", "local"] as const) {
    process.env.CADET_ENVIRONMENT = env;
    expect(brandEnvironment()).toBe(env);
    expect(logoSrc()).toBe(`/docs/cadet-logo-${env}.svg`);
  }
});

test("an unknown value falls back to production", () => {
  process.env.CADET_ENVIRONMENT = "sneakernet";
  expect(brandEnvironment()).toBe("production");
});
