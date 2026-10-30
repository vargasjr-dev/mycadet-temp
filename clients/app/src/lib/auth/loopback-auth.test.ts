import { afterEach, expect, test } from "bun:test";
import { startLoopbackAuth } from "./loopback-auth";
import { SEEDS } from "@mycadet/environments/seeds";
const originalWindow = window;
function useLocation(origin: string, port: string, config?: unknown) {
  const location = { origin, port, href: origin };
  // Model only the host capabilities consumed by this handoff; navigation
  // should record the URL without initiating a document load in happy-dom.
  Reflect.set(globalThis, "window", {
    location,
    ...(config === undefined ? {} : { __CADET_CONFIG__: config }),
  });
  return location;
}
afterEach(() => {
  Reflect.set(globalThis, "window", originalWindow);
  delete import.meta.env.VITE_ENVIRONMENT;
  sessionStorage.clear();
});
test("loopback persists a fresh state and destination and sends only the callback to cloud", async () => {
  // The cloud login base is the build seed's web url, not an injected field.
  import.meta.env.VITE_ENVIRONMENT = "production";
  const location = useLocation("http://localhost:4567", "4567", {
    remote: "local",
    baseUrl: "https://cloud.example",
  });
  await startLoopbackAuth("/assistant/checkout?package=super", {
    intent: "signup",
  });
  const firstState = sessionStorage.getItem("cadet:loopback:state");
  expect(firstState).toMatch(/^[a-f0-9]{64}$/);
  expect(sessionStorage.getItem("cadet:loopback:returnTo")).toBe(
    "/assistant/checkout?package=super",
  );
  const target = new URL(location.href);
  expect(target.origin).toBe(SEEDS.production.webUrl);
  expect(target.pathname).toBe("/account/signup");
  expect(target.searchParams.get("returnTo")).toBe(
    `/accounts/cli/callback?port=4567&state=${firstState}`,
  );
  await startLoopbackAuth();
  expect(sessionStorage.getItem("cadet:loopback:state")).not.toBe(firstState);
  expect(new URL(location.href).pathname).toBe("/account/login");
});
