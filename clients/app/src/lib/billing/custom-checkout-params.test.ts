import { expect, test } from "bun:test";
import { parseCustomCheckoutSelection } from "./custom-checkout-params";

test("custom selection requires storage and preserves omitted optional dimensions", () => {
  expect(
    parseCustomCheckoutSelection(new URLSearchParams("storage_tier=xs")),
  ).toEqual({ machineTier: null, storageTier: "xs", creditTier: null });
  expect(
    parseCustomCheckoutSelection(
      new URLSearchParams(
        "machine_tier=large&storage_tier=s&credit_tier=credits_50",
      ),
    ),
  ).toEqual({
    machineTier: "large",
    storageTier: "s",
    creditTier: "credits_50",
  });
});
test("missing, blank, retired, and package-only custom tiers fail closed", () => {
  for (const query of [
    "",
    "machine_tier=large",
    "storage_tier=",
    "storage_tier=xl",
    "storage_tier=xxl",
    "storage_tier=s&machine_tier=small",
    "storage_tier=s&machine_tier=",
    "storage_tier=s&credit_tier=credits_45",
    "storage_tier=s&credit_tier=credits_115",
    "storage_tier=s&credit_tier=",
    "storage_tier=s&credit_tier=free",
  ]) {
    expect(parseCustomCheckoutSelection(new URLSearchParams(query))).toBeNull();
  }
});
