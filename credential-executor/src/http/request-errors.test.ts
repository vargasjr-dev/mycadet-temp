import { expect, test } from "bun:test";
import { withCesHttpErrorLogging } from "./request-errors.js";

test("CES HTTP failures log the exception and return a safe correlation id", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const failure = new Error("backend unavailable");
  const response = await withCesHttpErrorLogging(
    new Request("http://127.0.0.1:8090/v1/credentials", {
      headers: { Authorization: "Bearer fixture-secret" },
    }),
    async () => {
      throw failure;
    },
    {
      error: (context) => {
        captured.push(context);
      },
    },
  );
  const body = await response.json();
  expect(response.status).toBe(500);
  expect(body.error).toBe("Internal server error");
  expect(body.request_id).toBe(response.headers.get("x-ces-error-id"));
  expect(captured[0]?.err).toBe(failure);
  expect(captured[0]?.method).toBe("GET");
  expect(captured[0]?.path).toBe("/v1/credentials");
  expect(JSON.stringify(body)).not.toContain("fixture-secret");
  expect(JSON.stringify(captured)).not.toContain("fixture-secret");
});
