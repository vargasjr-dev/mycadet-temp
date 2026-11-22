/**
 * CLI command: `assistant ps`
 *
 * Thin IPC wrapper over the daemon's `ps` route. Renders the daemon's own
 * process tree (the assistant runtime and its supervised subsystems —
 * qdrant, embed-worker) to the console. The route owns the live probing;
 * the CLI just forwards the request and formats the response.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { truncateCommandLabel } from "../../util/process-tree.js";
import { applyCommandHelp } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";
import { psHelp } from "./ps.help.js";

interface ProcessEntry {
  name: string;
  status: "running" | "not_running" | "unreachable";
  /** `workspace`, or `plugin:<name>` when spawned from a plugin. */
  origin: "workspace" | `plugin:${string}`;
  children?: ProcessEntry[];
  info?: string;
  pid?: number;
  tool?: { toolName: string; conversationId: string };
  cpuPct?: number;
  rssBytes?: number;
}

interface PsResponse {
  processes: ProcessEntry[];
}

/**
 * One flattened output row. Column 1 (`name`) carries the hierarchy
 * indentation; the remaining columns are aligned to a common start index
 * across all rows regardless of tree depth.
 */
const PROCESS_NAME_WIDTH = 30;

interface Row {
  name: string;
  pid: string;
  source: string;
  conversation: string;
  cpu: string;
  ram: string;
}

function flattenEntries(entry: ProcessEntry, depth: number, rows: Row[]): void {
  rows.push({
    name: truncateCommandLabel(
      "  ".repeat(Math.min(depth, 10)) + entry.name,
      PROCESS_NAME_WIDTH,
    ),
    pid: entry.pid?.toString() ?? entry.info?.replace(/^pid /, "") ?? "—",
    source: entry.tool
      ? `tool:${entry.tool.toolName}`
      : entry.origin.startsWith("plugin:")
        ? entry.origin
        : "—",
    conversation: entry.tool?.conversationId ?? "—",
    cpu: entry.cpuPct == null ? "—" : `${entry.cpuPct.toFixed(1)}%`,
    ram:
      entry.rssBytes == null
        ? "—"
        : `${(entry.rssBytes / 1024 / 1024).toFixed(1)} MiB`,
  });
  for (const child of entry.children ?? []) {
    flattenEntries(child, depth + 1, rows);
  }
}

function renderRows(rows: Row[]): void {
  const headers = ["PROCESS", "PID", "SOURCE", "CONVERSATION", "CPU", "RAM"];
  const values = rows.map((r) => [
    r.name,
    r.pid,
    r.source,
    r.conversation,
    r.cpu,
    r.ram,
  ]);
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...values.map((row) => row[i].length)),
  );
  const render = (row: string[]) =>
    row
      .map((cell, i) =>
        i === 1 || i >= 4 ? cell.padStart(widths[i]) : cell.padEnd(widths[i]),
      )
      .join("  ");
  const rule = widths.map((width) => "─".repeat(width)).join("──");
  log.info(render(headers));
  log.info(rule);
  for (const row of values) {
    log.info(render(row));
  }
  log.info(rule);
}

export function registerPsCommand(program: Command): void {
  registerCommand(program, {
    name: psHelp.name,
    transport: "ipc",
    description: psHelp.description,
    build: (ps) => {
      applyCommandHelp(ps, psHelp);

      ps.action(async (_opts, cmd: Command) => {
        const r = await cliIpcCall<PsResponse>("ps");
        if (!r.ok) {
          return exitFromIpcResult(r);
        }

        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, r.result);
          return;
        }

        const processes = r.result?.processes ?? [];
        if (processes.length === 0) {
          log.info("No processes reported.");
          return;
        }

        const rows: Row[] = [];
        for (const entry of processes) {
          flattenEntries(entry, 0, rows);
        }

        log.info("");
        renderRows(rows);
        log.info("");
      });
    },
  });
}
