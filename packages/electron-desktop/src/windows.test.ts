import { describe, expect, test } from "bun:test";

import { installWebContentsSecurity } from "./windows";

type Handler = (event: unknown) => void;

const forwarderFor = () => {
  const handlers = new Map<string, Handler>();
  const stub = {
    id: 2,
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    setWindowOpenHandler: () => true,
  } as unknown as Electron.WebContents;
  const lines: Array<[string, string]> = [];
  installWebContentsSecurity(stub, {
    cookies: () => undefined as never,
    logger: {
      error: (line: string) => lines.push(["error", line]),
      info: (line: string) => lines.push(["info", line]),
      warn: (line: string) => lines.push(["warning", line]),
    },
    openExternal: () => undefined,
  });
  return {
    emit: (event: Record<string, unknown>) =>
      handlers.get("console-message")?.(event),
    lines,
  };
};

describe("installWebContentsSecurity console forwarding", () => {
  test("forwards the app renderer's console with the wc prefix and level", () => {
    const forwarder = forwarderFor();
    forwarder.emit({
      level: "error",
      message: "TypeError: boom",
      sourceId: "https://mycadet.ai/assets/index.js",
      lineNumber: 7,
    });
    expect(forwarder.lines).toEqual([
      ["error", "[renderer wc=2] TypeError: boom"],
    ]);
  });

  test("never forwards the devtools frontend's own protocol chatter", () => {
    const forwarder = forwarderFor();
    // The exact pair Electron's inspector emits when it asks for the
    // Autofill CDP domain Electron does not implement.
    forwarder.emit({
      level: "error",
      message: `Request Autofill.enable failed. ${JSON.stringify({
        code: -32601,
        message: "'Autofill.enable' wasn't found",
      })}`,
      sourceId:
        "devtools://devtools/bundled/core/protocol_client/protocol_client.js",
      lineNumber: 1,
    });
    forwarder.emit({
      level: "error",
      message:
        "Request Autofill.setAddresses failed. " +
        JSON.stringify({
          code: -32601,
          message: "'Autofill.setAddresses' wasn't found",
        }),
      sourceId:
        "devtools://devtools/bundled/core/protocol_client/protocol_client.js",
      lineNumber: 1,
    });
    expect(forwarder.lines).toEqual([]);
  });

  test("debug-level renderer messages stay unforwarded", () => {
    const forwarder = forwarderFor();
    forwarder.emit({
      level: "debug",
      message: "verbose renderer chatter",
      sourceId: "https://mycadet.ai/assets/index.js",
      lineNumber: 1,
    });
    expect(forwarder.lines).toEqual([]);
  });
});
