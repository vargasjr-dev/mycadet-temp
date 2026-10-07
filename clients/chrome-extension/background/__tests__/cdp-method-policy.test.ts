import { describe, expect, test } from "bun:test";

import {
  commandRequiresTabBinding,
  isAllowedCdpMethod,
  tabBindingError,
} from "../cdp-method-policy.js";

describe("cdp-method-policy", () => {
  test("allows page-scoped browser tool methods and mediated Cadet helpers", () => {
    expect(isAllowedCdpMethod("Page.navigate")).toBe(true);
    expect(isAllowedCdpMethod("Runtime.evaluate")).toBe(true);
    expect(isAllowedCdpMethod("DOM.getDocument")).toBe(true);
    expect(isAllowedCdpMethod("Input.insertText")).toBe(true);
    expect(isAllowedCdpMethod("Accessibility.getFullAXTree")).toBe(true);
    expect(isAllowedCdpMethod("Network.getAllCookies")).toBe(true);
    expect(isAllowedCdpMethod("Cadet.createTab")).toBe(true);
    expect(isAllowedCdpMethod("Cadet.attach")).toBe(true);
  });

  test("denies browser-wide, target, and debugger methods", () => {
    expect(isAllowedCdpMethod("Browser.getVersion")).toBe(false);
    expect(isAllowedCdpMethod("Target.attachToTarget")).toBe(false);
    expect(isAllowedCdpMethod("Debugger.enable")).toBe(false);
    expect(isAllowedCdpMethod("Cadet.unknown")).toBe(false);
  });

  test("requires an explicit tab binding for raw CDP and attach/detach", () => {
    expect(commandRequiresTabBinding("Cadet.createTab")).toBe(false);
    expect(commandRequiresTabBinding("Cadet.attach")).toBe(true);
    expect(tabBindingError("Page.navigate", undefined)).toBe(
      "cdpSessionId (tab binding) is required",
    );
    expect(tabBindingError("Page.navigate", "42")).toBeUndefined();
    expect(tabBindingError("Cadet.listTabs", undefined)).toBeUndefined();
  });
});
