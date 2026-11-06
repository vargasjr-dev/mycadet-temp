import { afterEach, expect, test } from "bun:test";
import { framePath, frameUrl, hostPath } from "./assistant-navigation";
import { AssistantResolutionSchema } from "../assistant/resolution-contract";

const origin = "https://site.example.com";

// The helpers read the shell's origin themselves — tests shadow
// window.location (the helpers only ever read `.origin` off it).
const originalLocation = Object.getOwnPropertyDescriptor(window, "location");
afterEach(() => {
  if (originalLocation)
    Object.defineProperty(window, "location", originalLocation);
  else Reflect.deleteProperty(window, "location");
});

function serveFrom(value: string): void {
  Object.defineProperty(window, "location", {
    value: new URL(value),
    configurable: true,
  });
}

for (const mount of ["/assistant", "/admin/assistant"]) {
  test(`deep links retain query and hash under ${mount}`, () => {
    serveFrom(origin);
    const location = `${mount}/conversations/123?view=files#item`;
    expect(frameUrl(location, mount)).toBe(`${origin}${location}`);
    // The bundle announces its paths under its own /assistant root.
    expect(
      hostPath("/assistant/conversations/123?view=files#item", mount),
    ).toBe(location);
    // ...and under the mount itself when it knows where it is mounted.
    expect(hostPath(`${mount}/conversations/123?view=files#item`, mount)).toBe(
      location,
    );
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
    serveFrom(origin);
    expect(() => hostPath(path, "/admin/assistant")).toThrow();
  });
}
test("relative entries resolve on the host and do not reset query or hashes", () => {
  serveFrom(origin);
  expect(framePath("/assistant?tab=chat#last", "/assistant")).toBe(
    "/assistant/?tab=chat#last",
  );
  expect(frameUrl("/assistant?tab=chat#last", "/assistant")).toBe(
    `${origin}/assistant/?tab=chat#last`,
  );
});
test("a public ready descriptor and readiness outcomes share one contract", () => {
  for (const status of ["empty", "notReady", "unauthenticated"]) {
    expect(AssistantResolutionSchema.safeParse({ status }).success).toBe(true);
  }
  expect(
    AssistantResolutionSchema.safeParse({
      status: "ready",
      assistant: {
        id: "assistant-1",
        version: "1.2.3",
      },
    }).success,
  ).toBe(true);
});
