import { expect, test } from "bun:test";
import { framePath, frameUrl, hostPath } from "./assistant-navigation";
import { AssistantResolutionSchema } from "../assistant/resolution-contract";
const origin = "https://site.example.com";
const entry = "https://runtime.example.com/web/1.2.3/assistant/";
for (const mount of ["/assistant", "/admin/assistant"]) {
  test(`deep links retain query and hash under ${mount}`, () => {
    const location = `${mount}/conversations/123?view=files#item`;
    expect(frameUrl(location, mount, entry, origin)).toBe(
      "https://runtime.example.com/web/1.2.3/assistant/conversations/123?view=files#item",
    );
    expect(
      hostPath(
        "/web/1.2.3/assistant/conversations/123?view=files#item",
        mount,
        entry,
        origin,
      ),
    ).toBe(location);
    expect(
      hostPath(
        "/assistant/conversations/123?view=files#item",
        mount,
        entry,
        origin,
      ),
    ).toBe(location);
  });
}
for (const path of [
  "//other.example.com/assistant",
  "https://other.example.com/assistant",
  "/assistant-other",
  "/account",
  "/assistant/../account",
  "/assistant/%2e%2e/account",
  "/assistant/\\other.example.com",
  "/web/other-version/assistant/",
]) {
  test(`frame messages cannot escape the assistant mount: ${path}`, () => {
    expect(() => hostPath(path, "/admin/assistant", entry, origin)).toThrow();
  });
}
test("relative entries resolve on the host and do not reset query or hashes", () => {
  expect(
    framePath(
      "/assistant?tab=chat#last",
      "/assistant",
      "/web/1.2.3/assistant/",
      origin,
    ),
  ).toBe("/web/1.2.3/assistant/?tab=chat#last");
  expect(
    frameUrl("/assistant", "/assistant", "/web/1.2.3/assistant/", origin),
  ).toBe(`${origin}/web/1.2.3/assistant/`);
});
for (const value of [
  "javascript:alert(1)",
  "//other.example.com/assistant/",
  "https://user:password@other.example.com/assistant/",
  "http://other.example.com/assistant/",
  "https://runtime.example.com/assistant/?token=secret",
  "not a URL",
  "https://[invalid/assistant/",
]) {
  test(`resolution rejects unsafe UI URLs without throwing: ${value}`, () => {
    expect(
      AssistantResolutionSchema.safeParse({
        status: "ready",
        assistant: {
          id: "assistant-1",
          version: "1.2.3",
          url: value,
        },
      }).success,
    ).toBe(false);
  });
}
test("a public ready descriptor and readiness outcomes share one contract", () => {
  for (const status of ["empty", "starting", "unauthenticated"]) {
    expect(AssistantResolutionSchema.safeParse({ status }).success).toBe(true);
  }
  expect(
    AssistantResolutionSchema.safeParse({
      status: "ready",
      assistant: {
        id: "assistant-1",
        version: "1.2.3",
        url: entry,
      },
    }).success,
  ).toBe(true);
});
