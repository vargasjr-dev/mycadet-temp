import { expect, test } from "bun:test";
import { createHostProxyClientHeaders } from "./router";

const identity = {
  getClientId: () => "mac-1",
  getMachineName: () => "Test Mac",
  interfaceId: "macos",
};

test("window capture is explicitly advertised by updated clients only", () => {
  expect(
    createHostProxyClientHeaders(identity).sseClientHeaders(),
  ).not.toHaveProperty("X-Cadet-Cu-Window-Capture");
  expect(
    createHostProxyClientHeaders({
      ...identity,
      supportsWindowCapture: true,
    }).sseClientHeaders(),
  ).toHaveProperty("X-Cadet-Cu-Window-Capture", "1");
});

test("coachmarks are explicitly advertised by clients that can draw them only", () => {
  expect(
    createHostProxyClientHeaders(identity).sseClientHeaders(),
  ).not.toHaveProperty("X-Cadet-Cu-Annotate");
  expect(
    createHostProxyClientHeaders({
      ...identity,
      supportsCoachmarks: true,
    }).sseClientHeaders(),
  ).toHaveProperty("X-Cadet-Cu-Annotate", "1");
});

// Independent opt-ins: a client can serve window-only observations without
// having a frame to draw marks on, and the daemon gates two different things
// on them.
test("window capture and coachmarks are advertised independently", () => {
  const headers = createHostProxyClientHeaders({
    ...identity,
    supportsWindowCapture: true,
  }).sseClientHeaders();
  expect(headers).toHaveProperty("X-Cadet-Cu-Window-Capture", "1");
  expect(headers).not.toHaveProperty("X-Cadet-Cu-Annotate");
});

test("batched actions are explicitly advertised by clients that run them only", () => {
  expect(
    createHostProxyClientHeaders(identity).sseClientHeaders(),
  ).not.toHaveProperty("X-Cadet-Cu-Sequence");
  expect(
    createHostProxyClientHeaders({
      ...identity,
      supportsSequence: true,
    }).sseClientHeaders(),
  ).toHaveProperty("X-Cadet-Cu-Sequence", "1");
});
