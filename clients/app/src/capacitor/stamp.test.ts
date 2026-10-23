import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { capacitorInjectedConfig, injectedConfigScript } from "./stamp";

describe("capacitorInjectedConfig", () => {
  // The house env pattern: snapshot the keys the stamp reads, restore
  // afterwards. The lockfile dir points at an empty temp dir by default so
  // the local stamp deterministically falls to the seed default.
  const KEYS = [
    "CADET_ENVIRONMENT",
    "CADET_LOCKFILE_DIR",
    "XDG_CONFIG_HOME",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let emptyDir: string;

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    emptyDir = mkdtempSync(join(tmpdir(), "cadet-stamp-empty-"));
    process.env.CADET_LOCKFILE_DIR = emptyDir;
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(emptyDir, { recursive: true, force: true });
  });

  test("local environment stamps the local backend as the control plane", () => {
    expect(capacitorInjectedConfig()).toEqual({
      remote: "local",
      cloudUrl: "http://localhost:8000",
    });
  });

  test("a running local cadet's tunnel record becomes the stamp", () => {
    writeLockfile(
      JSON.stringify({
        tunnel: {
          pid: 4321,
          provider: "cadet",
          startedAt: "2026-10-22T00:00:00Z",
          publicUrl: "https://tunnel.example.net",
        },
        assistants: [],
        activeAssistant: null,
      }),
    );
    expect(capacitorInjectedConfig()).toEqual({
      remote: "local",
      cloudUrl: "https://tunnel.example.net",
    });
  });

  test("the app server edge's loopback port stamps without a tunnel", () => {
    writeLockfile(
      JSON.stringify({
        app: { pid: 4322, port: 8000 },
        assistants: [],
        activeAssistant: null,
      }),
    );
    expect(capacitorInjectedConfig()).toEqual({
      remote: "local",
      cloudUrl: "http://127.0.0.1:8000",
    });
  });

  test("unset CADET_ENVIRONMENT reads the local cadet's lockfile, not production's", () => {
    // The local arm owns the "unset means the local cadet" contract, and
    // the lockfile read underneath resolves the environment the same way —
    // so the arm must pin its default before the read. Without the pin the
    // read falls to production, and a bare build never sees the local
    // stack's records (the seed default stamps instead).
    const home = mkdtempSync(join(tmpdir(), "cadet-stamp-home-"));
    const configHome = join(home, ".config");
    mkdirSync(join(configHome, "cadet-local"), { recursive: true });
    writeFileSync(
      join(configHome, "cadet-local", "lockfile.json"),
      JSON.stringify({
        app: { pid: 4322, port: 8000 },
        assistants: [],
        activeAssistant: null,
      }),
    );
    delete process.env.CADET_LOCKFILE_DIR;
    process.env.XDG_CONFIG_HOME = configHome;
    try {
      expect(capacitorInjectedConfig()).toEqual({
        remote: "local",
        cloudUrl: "http://127.0.0.1:8000",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("cloud environments stamp their web origin — the /v1 edge", () => {
    process.env.CADET_ENVIRONMENT = "production";
    expect(capacitorInjectedConfig()).toEqual({
      remote: "cloud",
      cloudUrl: "https://mycadet.ai",
    });
    process.env.CADET_ENVIRONMENT = "staging";
    expect(capacitorInjectedConfig()).toEqual({
      remote: "cloud",
      cloudUrl: "https://staging.mycadet.ai",
    });
    process.env.CADET_ENVIRONMENT = "dev";
    expect(capacitorInjectedConfig()).toEqual({
      remote: "cloud",
      cloudUrl: "https://dev.mycadet.ai",
    });
  });
});

function writeLockfile(content: string): void {
  writeFileSync(
    join(process.env.CADET_LOCKFILE_DIR!, "lockfile.json"),
    content,
  );
}

describe("injectedConfigScript", () => {
  // The script resolves the config itself — the local arm's lockfile is
  // driven through the env, snapshotted and restored like the describe
  // above.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cadet-stamp-escape-"));
    process.env.CADET_LOCKFILE_DIR = dir;
    process.env.CADET_ENVIRONMENT = "local";
  });

  afterEach(() => {
    delete process.env.CADET_LOCKFILE_DIR;
    delete process.env.CADET_ENVIRONMENT;
    rmSync(dir, { recursive: true, force: true });
  });

  test("the payload carries no raw < so tag breakout is impossible", () => {
    writeLockfile(
      JSON.stringify({
        tunnel: {
          pid: 4321,
          provider: "cadet",
          startedAt: "2026-10-22T00:00:00Z",
          publicUrl:
            "https://assistant.example.com/?a=</script><script>alert(1)</script>",
        },
        assistants: [],
        activeAssistant: null,
      }),
    );
    const script = injectedConfigScript();
    const payload = script.slice(
      "<script>window.__CADET_CONFIG__=".length,
      -"</script>".length,
    );
    expect(payload.includes("<")).toBe(false);
    expect(JSON.parse(payload)).toEqual({
      remote: "local",
      cloudUrl:
        "https://assistant.example.com/?a=\u003c/script\u003e\u003cscript\u003ealert(1)\u003c/script\u003e",
    });
  });
});
