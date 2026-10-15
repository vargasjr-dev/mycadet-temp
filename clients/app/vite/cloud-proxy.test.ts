import { expect, mock, test } from "bun:test";
import type http from "node:http";
import { injectCloudSessionToken } from "./cloud-proxy";
function forward(
  api: boolean,
  headers: http.IncomingHttpHeaders,
  token: string | null = "example-session-token",
) {
  const values = new Map<string, string>([["Cookie", "browser-cookie"]]);
  const read = mock(() => token);
  type Callback = Parameters<
    Parameters<ReturnType<typeof injectCloudSessionToken>>[0]["on"]
  >[1];
  let callback!: Callback;
  injectCloudSessionToken(
    api,
    read,
  )({
    on: (_event, handler) => {
      callback = handler;
    },
  });
  callback(
    {
      setHeader: (name, value) => {
        values.set(name, value);
      },
      removeHeader: (name) => {
        values.delete(name);
      },
    },
    { headers },
  );
  return { values, read };
}
test("API proxy uses the host token and removes cookies for a proven loopback request", () => {
  const { values } = forward(true, {
    host: "localhost:3001",
    origin: "http://localhost:3001",
  });
  expect(values.get("X-Session-Token")).toBe("example-session-token");
  expect(values.has("Cookie")).toBe(false);
});
test("allauth proxy uses session cookies rather than API headers", () => {
  const { values } = forward(false, {
    host: "localhost:3001",
    "sec-fetch-site": "same-origin",
  });
  expect(values.get("Cookie")).toBe(
    "sessionid=example-session-token; __Secure-sessionid=example-session-token",
  );
  expect(values.has("X-Session-Token")).toBe(false);
});
for (const headers of [
  { host: "localhost:3001" },
  { host: "localhost:3001", origin: "https://other.example.com" },
  {
    host: "localhost:3001",
    origin: "http://localhost:3001",
    "sec-fetch-site": "cross-site",
  },
  { host: "other.example.com", "sec-fetch-site": "same-origin" },
]) {
  test(`unproven request never reads host credentials: ${JSON.stringify(headers)}`, () => {
    const { values, read } = forward(true, headers);
    expect(read).not.toHaveBeenCalled();
    expect(values.has("X-Session-Token")).toBe(false);
  });
}
test("API cookies stay removed when no host session is registered", () => {
  const { values } = forward(
    true,
    { host: "localhost:3001", "sec-fetch-site": "same-origin" },
    null,
  );
  expect(values.has("Cookie")).toBe(false);
  expect(values.has("X-Session-Token")).toBe(false);
});
