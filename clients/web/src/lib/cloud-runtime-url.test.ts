import { afterEach, expect, test } from "bun:test";
import { getCloudRuntimeUrl } from "./cloud-runtime-url";

const originalConfig = window.__CADET_CONFIG__;
const originalEnvironment = process.env.VITE_ENVIRONMENT;
afterEach(() => {
  window.__CADET_CONFIG__ = originalConfig;
  if (originalEnvironment === undefined) {
    delete process.env.VITE_ENVIRONMENT;
  } else {
    process.env.VITE_ENVIRONMENT = originalEnvironment;
  }
});

for (const [environment, expected] of [
  ["production", "https://cloud.mycadet.ai"],
  ["dev", "https://dev-cloud.mycadet.ai"],
  ["staging", "https://staging-cloud.mycadet.ai"],
  ["test", "https://test-cloud.mycadet.ai"],
  ["local", "http://localhost:8000"],
  ["unknown", "https://cloud.mycadet.ai"],
]) {
  test(`${environment} selects its cloud API independently of the page or hub`, () => {
    process.env.VITE_ENVIRONMENT = environment;
    window.__CADET_CONFIG__ = {
      remote: "custom",
      hubUrl: "https://hub.example.com/assistant",
    };
    expect(getCloudRuntimeUrl()).toBe(expected);
  });
}
test("missing environment defaults to production", () => {
  delete process.env.VITE_ENVIRONMENT;
  window.__CADET_CONFIG__ = undefined;
  expect(getCloudRuntimeUrl()).toBe("https://cloud.mycadet.ai");
});
test("host cloud URL override wins over the build environment", () => {
  process.env.VITE_ENVIRONMENT = "production";
  window.__CADET_CONFIG__ = { cloudUrl: "https://cloud.example.com" };
  expect(getCloudRuntimeUrl()).toBe("https://cloud.example.com");
});
