/**
 * Request-body validation for the emit_event route.
 *
 * The handler validates with `parseBody`, so a malformed body is rejected with
 * a `BadRequestError` (→ 400) instead of the raw `ZodError` a bare `.parse()`
 * surfaces — which neither adapter maps, so it becomes a 500 — before any
 * event is emitted.
 *
 * The handler is synchronous, so `parseBody` throws during the call — hence
 * `expect(() => …).toThrow` rather than the `.rejects` form.
 */

import { describe, expect, test } from "bun:test";

import { BadRequestError } from "../errors.js";
import { registrationCapabilities, ROUTES } from "../events-routes.js";

const routeFor = (operationId: string) => {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`no route: ${operationId}`);
  }
  return route;
};

describe("emit_event body validation", () => {
  test("rejects an out-of-enum kind with BadRequestError", () => {
    expect(() =>
      routeFor("emit_event").handler({
        body: { kind: "bogus" },
      }),
    ).toThrow(BadRequestError);
  });

  test("rejects a body missing kind with BadRequestError", () => {
    expect(() => routeFor("emit_event").handler({ body: {} })).toThrow(
      BadRequestError,
    );
  });
});

describe("registrationCapabilities", () => {
  test("the embedded-renderer opt-out advertises no host capabilities", () => {
    // The desktop shell's web client registers under the shell's desktop
    // interface for identity but serves no host tools — the opt-out header
    // must zero the interface-derived capability set.
    expect(
      registrationCapabilities("windows", { "x-cadet-host-proxy": "0" }),
    ).toEqual([]);
    expect(
      registrationCapabilities("macos", { "x-cadet-host-proxy": "0" }),
    ).toEqual([]);
  });

  test("a desktop interface without the opt-out keeps its capabilities", () => {
    expect(registrationCapabilities("windows", {})).toEqual([
      "host_bash",
      "host_file",
      "host_cu",
      "host_browser",
      "host_ui_snapshot",
    ]);
  });

  test("macos adds the negotiated CU capabilities from its headers", () => {
    expect(
      registrationCapabilities("macos", {
        "x-cadet-cu-window-capture": "1",
        "x-cadet-cu-sequence": "1",
        "x-cadet-cu-annotate": "1",
      }),
    ).toEqual([
      "host_bash",
      "host_file",
      "host_cu",
      "host_browser",
      "host_ui_snapshot",
      "host_cu_window_capture",
      "host_cu_sequence",
      "host_cu_annotate",
    ]);
  });

  test("web and unknown interfaces advertise nothing", () => {
    expect(registrationCapabilities("web", {})).toEqual([]);
    expect(registrationCapabilities(null, {})).toEqual([]);
  });
});
