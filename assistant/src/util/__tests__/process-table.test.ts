import { describe, expect, test } from "bun:test";

import {
  dropProcessTableSelfRows,
  parsePsProcessTable,
  parseWindowsProcessTable,
} from "../process-table.js";

describe("parsePsProcessTable", () => {
  test("preserves command lines while parsing process relationships", () => {
    expect(
      parsePsProcessTable(
        "  10     1 /usr/bin/bun run worker.ts arg\n  11    10 helper\n",
      ),
    ).toEqual([
      { pid: 10, ppid: 1, command: "/usr/bin/bun run worker.ts arg" },
      { pid: 11, ppid: 10, command: "helper" },
    ]);
  });
});

describe("parseWindowsProcessTable", () => {
  test("parses PowerShell JSON and falls back to the image name", () => {
    expect(
      parseWindowsProcessTable(
        JSON.stringify([
          {
            ProcessId: 100,
            ParentProcessId: 4,
            CommandLine: "C:\\Program Files\\Bun\\bun.exe worker.ts",
            Name: "bun.exe",
            WorkingSetSize: 4096,
            HandleCount: 42,
          },
          {
            ProcessId: 101,
            ParentProcessId: 100,
            CommandLine: null,
            Name: "helper.exe",
          },
        ]),
      ),
    ).toEqual([
      {
        pid: 100,
        ppid: 4,
        command: "C:\\Program Files\\Bun\\bun.exe worker.ts",
        rssBytes: 4096,
        handleCount: 42,
      },
      { pid: 101, ppid: 100, command: "helper.exe" },
    ]);
  });

  test("handles the single-object shape emitted for one process", () => {
    expect(
      parseWindowsProcessTable(
        JSON.stringify({
          ProcessId: 100,
          ParentProcessId: 4,
          CommandLine: "worker.exe",
          Name: "worker.exe",
        }),
      ),
    ).toEqual([{ pid: 100, ppid: 4, command: "worker.exe" }]);
  });
});

describe("dropProcessTableSelfRows", () => {
  test("drops the ps enumeration's own row", () => {
    const rows = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 100, ppid: 42, command: "ps -A -ww -o pid=,ppid=,command=" },
      { pid: 101, ppid: 42, command: "bun run /app/daemon/main.ts" },
    ];
    expect(dropProcessTableSelfRows(rows)).toEqual([
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 101, ppid: 42, command: "bun run /app/daemon/main.ts" },
    ]);
  });

  test("drops the PowerShell enumeration's own row case-insensitively", () => {
    const rows = [
      {
        pid: 50,
        ppid: 4,
        command: "C:\\Program Files\\Bun\\bun.exe worker.ts",
      },
      {
        pid: 51,
        ppid: 50,
        command:
          "PowerShell.exe -NoProfile -NonInteractive -Command Get-CimInstance Win32_Process | ConvertTo-Json",
      },
    ];
    expect(dropProcessTableSelfRows(rows)).toEqual([
      {
        pid: 50,
        ppid: 4,
        command: "C:\\Program Files\\Bun\\bun.exe worker.ts",
      },
    ]);
  });

  test("keeps ordinary processes — a bare ps invocation without the enumeration args is a real process", () => {
    const rows = [
      { pid: 60, ppid: 4, command: "ps" },
      { pid: 61, ppid: 4, command: "ps aux" },
      { pid: 62, ppid: 4, command: "qdrant" },
    ];
    expect(dropProcessTableSelfRows(rows)).toEqual(rows);
  });
});
