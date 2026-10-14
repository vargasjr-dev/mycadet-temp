import { expect, test } from "bun:test";
import { isGeneratedPrincipalName } from "./is-generated-principal-name";

test("recognizes new and already issued guardian names without hiding chosen names", () => {
  expect(isGeneratedPrincipalName("principal-123")).toBe(true);
  expect(isGeneratedPrincipalName("cadet-principal-123")).toBe(true);
  expect(isGeneratedPrincipalName("Example User")).toBe(false);
});
