import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { fetchCurrentVersion } from "../daemon-readiness";

const request = spyOn(globalThis, "fetch");
afterEach(() => request.mockReset());
afterAll(() => request.mockRestore());

test("reads the gateway's version through the public health endpoint", async () => {
  request.mockResolvedValueOnce(
    Response.json({ version: "1.2.3", status: "ok" }),
  );
  expect(await fetchCurrentVersion("http://127.0.0.1:7830")).toBe("1.2.3");
  expect(request.mock.calls[0][0]).toBe("http://127.0.0.1:7830/healthz");
});

test("an unverified gateway response never supplies a release version", async () => {
  for (const value of [{}, null, { version: "" }, { version: 123 }]) {
    request.mockResolvedValueOnce(Response.json(value));
    expect(await fetchCurrentVersion("http://127.0.0.1:7830")).toBeUndefined();
  }
  request.mockResolvedValueOnce(new Response("not JSON"));
  expect(await fetchCurrentVersion("http://127.0.0.1:7830")).toBeUndefined();
  request.mockResolvedValueOnce(
    Response.json({ version: "1.2.3" }, { status: 503 }),
  );
  expect(await fetchCurrentVersion("http://127.0.0.1:7830")).toBeUndefined();
  request.mockRejectedValueOnce(new Error("offline"));
  expect(await fetchCurrentVersion("http://127.0.0.1:7830")).toBeUndefined();
});
