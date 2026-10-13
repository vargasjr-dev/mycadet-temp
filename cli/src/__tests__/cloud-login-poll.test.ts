import { describe, expect, test } from "bun:test";
import { pollingCloudLogin } from "../lib/cloud-login-poll.js";

const login = {
  request_id: "a".repeat(64),
  poll_secret: "b".repeat(64),
  verification_uri: "https://example.com/account/cli?request=test",
  user_code: "AAAAAAAA",
  interval: 1,
};

describe("terminal login polling", () => {
  test("prints the browser URL/code and waits for approval using a private poll secret", async () => {
    const logs: string[] = [];
    const bodies: unknown[] = [];
    let polls = 0;
    const request = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      bodies.push(init?.body);
      if (String(url).endsWith("/start")) return Response.json(login);
      return ++polls === 1
        ? Response.json({ status: "pending" }, { status: 202 })
        : Response.json({ session_token: "session-test" });
    }) as typeof fetch;
    expect(
      await pollingCloudLogin("https://cloud.example.com", {
        fetch: request,
        log: (line) => logs.push(line),
      }),
    ).toBe("session-test");
    expect(polls).toBe(2);
    expect(logs.join("\n")).toContain(login.verification_uri);
    expect(logs.join("\n")).toContain(login.user_code);
    expect(logs.join("\n")).not.toContain(login.poll_secret);
    expect(JSON.parse(String(bodies[1]))).toEqual({
      request_id: login.request_id,
      poll_secret: login.poll_secret,
    });
  });

  test("times out even while a network request is hung", async () => {
    const request = (async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      })) as typeof fetch;
    await expect(
      pollingCloudLogin("https://example.com", {
        fetch: request,
        timeoutMs: 20,
      }),
    ).rejects.toThrow("Login timed out after 5 minutes");
  });

  test("expired approval fails without returning a token", async () => {
    const request = (async (url: unknown) =>
      String(url).endsWith("/start")
        ? Response.json(login)
        : Response.json({}, { status: 410 })) as typeof fetch;
    await expect(
      pollingCloudLogin("https://example.com", {
        fetch: request,
        log: () => {},
      }),
    ).rejects.toThrow("expired");
  });
});
