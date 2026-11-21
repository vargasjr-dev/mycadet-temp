import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, test } from "bun:test";

import {
  getToolProcessOwner,
  runInToolProcessContext,
  trackToolProcess,
} from "../tool-process-context.js";

const fallback = { toolName: "bash", conversationId: "fallback" };

describe("tool process ownership", () => {
  test("concurrent invocations retain their actual tool name across awaits and clean up after exit", async () => {
    const children = await Promise.all(
      ["conv-a", "conv-b"].map((conversationId) =>
        runInToolProcessContext(
          { toolName: "custom-skill", conversationId },
          async () => {
            await Promise.resolve();
            const child = spawn(
              process.execPath,
              ["-e", "setInterval(() => {}, 1000)"],
              { stdio: "ignore", windowsHide: true },
            );
            trackToolProcess(child, fallback);
            return { child, conversationId };
          },
        ),
      ),
    );
    try {
      for (const { child, conversationId } of children) {
        expect(getToolProcessOwner(child.pid!)).toEqual({
          toolName: "custom-skill",
          conversationId,
        });
      }
    } finally {
      await Promise.all(
        children.map(async ({ child }) => {
          const closed = once(child, "close");
          child.kill();
          await closed;
          expect(getToolProcessOwner(child.pid!)).toBeUndefined();
        }),
      );
    }
  });

  test("direct shell calls use their explicit fallback", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    trackToolProcess(child, fallback);
    try {
      expect(getToolProcessOwner(child.pid!)).toEqual(fallback);
    } finally {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
  });
});
