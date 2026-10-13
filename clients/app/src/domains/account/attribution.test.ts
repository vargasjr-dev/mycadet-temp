import { describe, expect, test } from "bun:test";
import { readAttributionParams, withPreservedAttribution } from "./attribution";

describe("readAttributionParams", () => {
  test("collects the params a paid-social landing carries", () => {
    const collected = readAttributionParams(
      "?utm_source=ig&utm_medium=paid-social&utm_campaign=personal-ai&fbclid=abc123",
    );

    expect(collected).toEqual({
      utm_source: "ig",
      utm_medium: "paid-social",
      utm_campaign: "personal-ai",
      fbclid: "abc123",
    });
  });

  test("collects nothing for an organic arrival", () => {
    expect(readAttributionParams("?returnTo=%2Fassistant")).toEqual({});
  });

  test("bounds an oversized value", () => {
    const collected = readAttributionParams(`?fbclid=${"x".repeat(5000)}`);

    expect(collected["fbclid"]).toHaveLength(512);
  });
});

describe("withPreservedAttribution", () => {
  test("appends attribution after an existing returnTo", () => {
    const href = withPreservedAttribution(
      "/account/signup?returnTo=%2Fassistant",
      "?utm_source=ig&fbclid=abc123",
    );

    expect(href).toBe(
      "/account/signup?returnTo=%2Fassistant&utm_source=ig&fbclid=abc123",
    );
  });

  test("starts the query string on a bare route", () => {
    expect(withPreservedAttribution("/account/signup", "?utm_source=ig")).toBe(
      "/account/signup?utm_source=ig",
    );
  });

  test("leaves the href untouched for an organic arrival", () => {
    expect(
      withPreservedAttribution(
        "/account/signup?returnTo=%2Fassistant",
        "?returnTo=%2Fassistant",
      ),
    ).toBe("/account/signup?returnTo=%2Fassistant");
    expect(withPreservedAttribution("/account/signup", "")).toBe(
      "/account/signup",
    );
  });

  test("does not carry non-allowlisted params", () => {
    expect(
      withPreservedAttribution("/account/signup", "?debug=1&utm_source=ig"),
    ).toBe("/account/signup?utm_source=ig");
  });

  test("keeps the href's existing value on a conflicting key", () => {
    expect(
      withPreservedAttribution("/account/signup?utm_source=x", "?utm_source=y"),
    ).toBe("/account/signup?utm_source=x");
  });

  test("appends only the keys the href does not already carry", () => {
    expect(
      withPreservedAttribution(
        "/account/signup?utm_source=x",
        "?utm_source=y&fbclid=abc123",
      ),
    ).toBe("/account/signup?utm_source=x&fbclid=abc123");
  });

  test("is idempotent when re-applied with the same search", () => {
    const search = "?utm_source=ig&fbclid=abc123";
    const once = withPreservedAttribution(
      "/account/signup?returnTo=%2Fassistant",
      search,
    );

    expect(withPreservedAttribution(once, search)).toBe(once);
  });
});
