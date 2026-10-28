import { afterEach, describe, expect, mock, test } from "bun:test";

// Capture the `client` path param each allauth SDK call receives.
const calls: Array<{ fn: string; client: string }> = [];

/** Body each stubbed call resolves with; tests swap it per scenario. */
const stubBody = { value: {} as unknown };

function sdkStub(fn: string) {
  return (opts: { path: { client: string } }) => {
    calls.push({ fn, client: opts.path.client });
    return Promise.resolve({
      data: { data: stubBody.value },
      error: undefined,
      response: { status: 200 },
    });
  };
}

mock.module("@/generated/auth/sdk.gen", () => ({
  getAllauthByClientV1AuthSession: sdkStub("getSession"),
}));

const { getSession } = await import("@/lib/auth/allauth-client");

function setElectron(): void {
  (window as unknown as { cadet?: unknown }).cadet = { platform: "electron" };
}

afterEach(() => {
  delete (window as unknown as { cadet?: unknown }).cadet;
  calls.length = 0;
  stubBody.value = {};
});

describe("allauth-client — client selection", () => {
  test("uses the browser client on web", async () => {
    await getSession();
    expect(calls.at(-1)?.client).toBe("browser");
  });

  test("uses the app client in Electron", async () => {
    setElectron();
    await getSession();
    expect(calls.map((c) => c.client)).toEqual(["app"]);
  });
});
