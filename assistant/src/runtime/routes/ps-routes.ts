/**
 * Daemon-side process status endpoint (GET /v1/ps).
 *
 * Walks the OS process tree rooted at the daemon (`process.pid`) and reports
 * every descendant process that is actually parented to it — qdrant, the
 * embed worker, the memory worker (when the daemon owns it), MCP servers, and
 * any other live children. The tree is built from the native process table
 * (`/proc` on Linux, `ps` on macOS), so it reflects reality rather than a
 * hard-coded subsystem list.
 */

import { z } from "zod";

import { getCesClient } from "../../credential-execution/ces-runtime.js";
import { getLogger } from "../../util/logger.js";
import {
  buildProcessTree,
  listProcesses,
  type ProcTreeNode,
} from "../../util/process-tree.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("ps-routes");

type ProcessStatus = "running" | "not_running" | "unreachable";

/**
 * `workspace` for the daemon and its subsystems; `plugin:<name>` for a
 * process spawned from a plugin (e.g. `plugin:default-memory`, `plugin:cognee`).
 */
type ProcessOrigin = "workspace" | `plugin:${string}`;

interface ProcessEntry {
  name: string;
  status: ProcessStatus;
  /** `workspace`, or `plugin:<name>` when spawned from a plugin. */
  origin: ProcessOrigin;
  children?: ProcessEntry[];
  info?: string;
}

const processOriginSchema = z
  .string()
  .regex(/^(workspace|plugin:.+)$/)
  .describe(
    "Process origin: 'workspace' for the daemon and its subsystems, or 'plugin:<name>' for a process spawned from a plugin (e.g. 'plugin:default-memory', 'plugin:cognee').",
  ) as z.ZodType<ProcessOrigin>;

const processEntrySchema: z.ZodType<ProcessEntry> = z
  .lazy(() =>
    z.object({
      name: z.string(),
      status: z.enum(["running", "not_running", "unreachable"]),
      origin: processOriginSchema,
      children: z.array(processEntrySchema).optional(),
      info: z.string().optional(),
    }),
  )
  .meta({ id: "ProcessEntry" });

const psResponseSchema = z.object({
  processes: z.array(processEntrySchema),
});

/** Map a native process-tree node onto the wire `ProcessEntry` shape. */
function toEntry(node: ProcTreeNode): ProcessEntry {
  const entry: ProcessEntry = {
    name: node.name,
    // Every node in the walk is a live process by definition.
    status: "running",
    origin: node.origin,
    info: `pid ${node.pid}`,
  };
  if (node.children.length > 0) {
    entry.children = node.children.map(toEntry);
  }
  return entry;
}

async function getProcessStatus() {
  const processes: ProcessEntry[] = [];
  try {
    const procs = await listProcesses();
    const entry = toEntry(buildProcessTree(procs, process.pid));
    // The daemon's own node derives its name from the entry script
    // (`daemon-main`); callers know this process as the assistant itself —
    // the fallback branch below already reports that name.
    entry.name = "assistant";
    processes.push(entry);
  } catch (err) {
    // Enumeration failed (no /proc and `ps` unavailable). Still report the
    // daemon itself so the endpoint stays useful for liveness.
    log.warn({ err }, "Failed to enumerate process tree");
    processes.push({
      name: "assistant",
      status: "running",
      origin: "workspace",
      info: `pid ${process.pid}`,
    });
  }

  // The credential executor is a sibling process (CLI-launched) or sidecar
  // container, not a child of the daemon — the process tree above can never
  // contain it. Report it live from the assistant's own RPC connection,
  // mirroring readyz: connected+handshaked is running, anything else is not.
  const cesConnected = getCesClient()?.isReady() ?? false;
  processes.push({
    name: "credential-executor",
    status: cesConnected ? "running" : "not_running",
    origin: "workspace",
    info: cesConnected ? "rpc session established" : "no rpc session",
  });

  return { processes };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "ps",
    endpoint: "ps",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: getProcessStatus,
    summary: "Process status",
    description:
      "Returns the daemon's process tree: every descendant process parented to the assistant runtime, built from the native OS process table.",
    tags: ["system"],
    responseBody: psResponseSchema,
  },
];
