import { expect, test } from "bun:test";
import { createHostProxyClientHeaders } from "./router";

test("the client negotiates nothing — capability headers are gone", () => {
  const headers = createHostProxyClientHeaders({
    interfaceId: "macos",
  }).sseClientHeaders();

  // Capabilities are derived server-side from the interface id (the
  // HOST_PROXY_SUPPORT table); the client stamps identity and nothing else.
  for (const key of [
    "X-Cadet-Cu-Window-Capture",
    "X-Cadet-Cu-Sequence",
    "X-Cadet-Cu-Annotate",
    "X-Cadet-Host-Proxy",
  ]) {
    expect(headers).not.toHaveProperty(key);
  }
  expect(headers).toHaveProperty("X-Cadet-Interface-Id", "macos");
});
