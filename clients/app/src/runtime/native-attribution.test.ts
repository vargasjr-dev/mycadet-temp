import { afterEach, expect, mock, test } from "bun:test";
const capture = mock(
  async (): Promise<Record<string, string>> => ({ utm_source: "play" }),
);
mock.module("@app/runtime/install-referrer", () => ({
  captureInstallReferrer: capture,
}));
const { resolveNativeAttribution } = await import("./native-attribution");
const descriptor = Object.getOwnPropertyDescriptor(window, "location");
afterEach(() => {
  if (descriptor) Object.defineProperty(window, "location", descriptor);
  capture.mockClear();
});
function search(value: string) {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { search: value },
  });
}
test("explicit attribution then URL attribution take precedence without merging install referrer", async () => {
  search("?utm_source=url&gclid=click");
  expect(await resolveNativeAttribution({ utm_source: "override" })).toEqual({
    utm_source: "override",
  });
  expect(await resolveNativeAttribution(undefined)).toEqual({
    utm_source: "url",
    gclid: "click",
  });
  expect(capture).not.toHaveBeenCalled();
});
test("install referrer supplies the fallback; empty attribution stays absent", async () => {
  search("?unrecognized=value");
  expect(await resolveNativeAttribution(undefined)).toEqual({
    utm_source: "play",
  });
  capture.mockResolvedValueOnce({});
  expect(await resolveNativeAttribution(undefined)).toBeUndefined();
});
