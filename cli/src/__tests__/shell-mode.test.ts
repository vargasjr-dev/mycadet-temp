import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DEFAULT_SHELL_MODE,
  readShellMode,
  saveShellMode,
} from "../lib/ingress-config.js";

describe("ingress shell mode setting", () => {
  const dirs: string[] = [];

  function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "cadet-shell-mode-test-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an absent config reads as the web default", () => {
    expect(readShellMode(workspace())).toBe("web");
  });

  test("a config without the key reads as the web default", () => {
    const ws = workspace();
    mkdirSync(join(ws, "data"), { recursive: true });
    writeFileSync(
      join(ws, "config.json"),
      JSON.stringify({ ingress: { publicBaseUrl: "https://edge.example" } }),
    );
    expect(readShellMode(ws)).toBe(DEFAULT_SHELL_MODE);
    expect(readShellMode(ws)).toBe("web");
  });

  test("saves and reads back the app mode", () => {
    const ws = workspace();
    saveShellMode(ws, "app");
    expect(readShellMode(ws)).toBe("app");
    saveShellMode(ws, "web");
    expect(readShellMode(ws)).toBe("web");
  });

  test("saving preserves the rest of the config", () => {
    const ws = workspace();
    mkdirSync(join(ws, "data"), { recursive: true });
    writeFileSync(
      join(ws, "config.json"),
      JSON.stringify({
        ingress: {
          enabled: true,
          publicBaseUrl: "https://edge.example",
          nginx: { listenPort: 7840 },
        },
        llm: { default: { provider: "anthropic" } },
      }),
    );
    saveShellMode(ws, "app");
    const saved = JSON.parse(
      readFileSync(join(ws, "config.json"), "utf-8"),
    ) as Record<string, any>;
    expect(saved.ingress.shell).toBe("app");
    expect(saved.ingress.publicBaseUrl).toBe("https://edge.example");
    expect(saved.ingress.enabled).toBe(true);
    expect(saved.ingress.nginx).toEqual({ listenPort: 7840 });
    expect(saved.llm).toEqual({ default: { provider: "anthropic" } });
  });

  test("an unrecognized value fails loudly instead of defaulting", () => {
    const ws = workspace();
    mkdirSync(join(ws, "data"), { recursive: true });
    writeFileSync(
      join(ws, "config.json"),
      JSON.stringify({ ingress: { shell: "aps" } }),
    );
    expect(() => readShellMode(ws)).toThrow('must be "web" or "app"');
  });
});
