import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { z } from "zod";

import { ROUTES } from "../runtime/routes/background-tool-routes.js";
import { BadRequestError } from "../runtime/routes/errors.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";
import {
  _clearRegistryForTesting,
  recordCompletedBackgroundTool,
  registerBackgroundTool,
} from "../tools/background-tool-registry.js";
import { jsonObjectSchema } from "./helpers/json-object-schema.js";

// ── Helpers ───────────────────────────────────────────────────────────

const listResponseSchema = z.object({
  tools: z.array(jsonObjectSchema),
  completed: z.array(jsonObjectSchema),
});
const cancelResponseSchema = z.object({ cancelled: z.boolean() });

function findRoute(operationId: string) {
  const route = ROUTES.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!route) {
    throw new Error(`Missing route ${operationId}`);
  }
  return route;
}

async function listBackgroundTools(args: RouteHandlerArgs) {
  return listResponseSchema.parse(
    await findRoute("background_tool_list").handler(args),
  );
}

async function cancelBackgroundTool(args: RouteHandlerArgs) {
  return cancelResponseSchema.parse(
    await findRoute("background_tool_cancel").handler(args),
  );
}

function makeTool(overrides: {
  id: string;
  toolName?: string;
  conversationId?: string;
  command?: string;
  startedAt?: number;
}) {
  return {
    id: overrides.id,
    toolName: overrides.toolName ?? "bash",
    conversationId: overrides.conversationId ?? "conv-1",
    command: overrides.command ?? "sleep 10",
    startedAt: overrides.startedAt ?? Date.now(),
    cancel: mock(() => {}),
  };
}

// ── Setup / Teardown ──────────────────────────────────────────────────

beforeEach(() => {
  _clearRegistryForTesting();
});

afterEach(() => {
  _clearRegistryForTesting();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("background tool routes", () => {
  describe("GET /v1/background-tools (list)", () => {
    test("returns empty arrays when no tools are registered", async () => {
      const result = await listBackgroundTools({});

      expect(result.tools).toEqual([]);
      expect(result.completed).toEqual([]);
    });

    test("returns recently-completed tools with terminal fields", async () => {
      recordCompletedBackgroundTool({
        id: "bg-done-1",
        toolName: "bash",
        conversationId: "conv-1",
        command: "npm run build",
        startedAt: 1700000000000,
        status: "completed",
        exitCode: 0,
        output: "built",
        completedAt: 1700000004200,
      });

      const result = await listBackgroundTools({});

      expect(result.tools).toEqual([]);
      expect(result.completed).toHaveLength(1);
      expect(result.completed[0]).toMatchObject({
        id: "bg-done-1",
        status: "completed",
        exitCode: 0,
        output: "built",
        completedAt: 1700000004200,
      });
    });

    test("filters completed tools by conversationId", async () => {
      recordCompletedBackgroundTool({
        id: "bg-d1",
        toolName: "bash",
        conversationId: "conv-a",
        command: "x",
        startedAt: 1,
        status: "completed",
        exitCode: 0,
        output: "",
        completedAt: 2,
      });
      recordCompletedBackgroundTool({
        id: "bg-d2",
        toolName: "bash",
        conversationId: "conv-b",
        command: "x",
        startedAt: 1,
        status: "failed",
        exitCode: 1,
        output: "",
        completedAt: 2,
      });

      const result = await listBackgroundTools({
        queryParams: { conversationId: "conv-a" },
      });

      expect(result.completed.map((t) => t.id)).toEqual(["bg-d1"]);
    });

    test("returns registered tools with toolName field", async () => {
      const tool = makeTool({
        id: "bg-abc123",
        toolName: "host_bash",
        conversationId: "conv-1",
        command: "npm test",
        startedAt: 1700000000000,
      });
      registerBackgroundTool(tool);

      const result = await listBackgroundTools({});

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]!.id).toBe("bg-abc123");
      expect(result.tools[0]!.toolName).toBe("host_bash");
      expect(result.tools[0]!.conversationId).toBe("conv-1");
      expect(result.tools[0]!.command).toBe("npm test");
      expect(result.tools[0]!.startedAt).toBe(1700000000000);
    });

    test("does not include the cancel function in the response", async () => {
      registerBackgroundTool(makeTool({ id: "bg-1" }));

      const result = await listBackgroundTools({});

      expect(result.tools[0]).not.toHaveProperty("cancel");
    });

    test("filters by conversationId", async () => {
      registerBackgroundTool(
        makeTool({ id: "bg-1", conversationId: "conv-a" }),
      );
      registerBackgroundTool(
        makeTool({ id: "bg-2", conversationId: "conv-b" }),
      );
      registerBackgroundTool(
        makeTool({ id: "bg-3", conversationId: "conv-a" }),
      );

      const result = await listBackgroundTools({
        queryParams: { conversationId: "conv-a" },
      });

      expect(result.tools).toHaveLength(2);
      expect(result.tools.map((t) => t.id).sort()).toEqual(["bg-1", "bg-3"]);
    });

    test("returns all tools when conversationId is not provided", async () => {
      registerBackgroundTool(
        makeTool({ id: "bg-1", conversationId: "conv-a" }),
      );
      registerBackgroundTool(
        makeTool({ id: "bg-2", conversationId: "conv-b" }),
      );

      const result = await listBackgroundTools({});

      expect(result.tools).toHaveLength(2);
    });
  });

  describe("POST /v1/background-tools/cancel", () => {
    test("cancels a registered tool and returns cancelled: true", async () => {
      const tool = makeTool({ id: "bg-cancel-me" });
      registerBackgroundTool(tool);

      const result = await cancelBackgroundTool({
        body: { id: "bg-cancel-me" },
      });

      expect(result.cancelled).toBe(true);
      expect(tool.cancel).toHaveBeenCalled();
    });

    test("returns cancelled: false for unknown ID", async () => {
      const result = await cancelBackgroundTool({
        body: { id: "bg-nonexistent" },
      });

      expect(result.cancelled).toBe(false);
    });

    test("throws BadRequestError when id is not provided", async () => {
      await expect(cancelBackgroundTool({ body: {} })).rejects.toThrow(
        BadRequestError,
      );
    });

    test("throws BadRequestError when body is empty", async () => {
      await expect(cancelBackgroundTool({})).rejects.toThrow(BadRequestError);
    });
  });
});
