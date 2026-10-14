import { afterEach, expect, test } from "bun:test";
import { getPlatformRuntimeUrl } from "./cloud-runtime-url";

const originalConfig = window.__CADET_CONFIG__;
afterEach(() => {
  window.__CADET_CONFIG__ = originalConfig;
});

for (const remote of ["docker", "custom"] as const) {
  test(`${remote} cloud traffic uses the cloud hub, not the gateway origin`, () => {
    window.__CADET_CONFIG__ = {
      remote,
      hubUrl: "https://staging.mycadet.ai/assistant",
    };
    expect(getPlatformRuntimeUrl()).toBe("https://staging.mycadet.ai");
  });
  test(`${remote} honors an explicit cloud backend`, () => {
    window.__CADET_CONFIG__ = { remote, cloudUrl: "https://cloud.example.com" };
    expect(getPlatformRuntimeUrl()).toBe("https://cloud.example.com");
  });
  test(`${remote} older configs fall back to the production cloud hub`, () => {
    window.__CADET_CONFIG__ = { remote };
    expect(getPlatformRuntimeUrl()).toBe("https://mycadet.ai");
  });
}
test("cloud SPA keeps its same-origin session endpoint", () => {
  window.__CADET_CONFIG__ = { remote: "cloud" };
  expect(getPlatformRuntimeUrl()).toBe(window.location.origin);
});
