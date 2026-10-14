import { expect, test } from "bun:test";
import { beginOAuthFlow, isOAuthFlowInFlight } from "./oauth-flow-state";

test("overlapping OAuth scopes suppress resume until the last flow finishes", () => {
  const first = beginOAuthFlow();
  const second = beginOAuthFlow();
  expect(isOAuthFlowInFlight()).toBe(true);
  first();
  first();
  expect(isOAuthFlowInFlight()).toBe(true);
  second();
  expect(isOAuthFlowInFlight()).toBe(false);
});
