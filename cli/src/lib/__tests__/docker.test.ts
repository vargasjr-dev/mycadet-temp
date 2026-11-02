import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  collectWatchTargets,
  resolveDockerHatchMode,
  resolveDockerProviderCredentialSetupAction,
} from "../remotes/docker.js";

describe("resolveDockerProviderCredentialSetupAction", () => {
  test("defers provider setup in detached mode", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: "anthropic",
        detached: true,
      }),
    ).toBe("defer");
  });

  test("reports missing guardian token only when a lease was expected", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: "anthropic",
        detached: false,
      }),
    ).toBe("missing-token");
  });

  test("configures provider setup when a guardian token is available", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: "anthropic",
        guardianAccessToken: "guardian-token",
        detached: false,
      }),
    ).toBe("configure");
  });

  test("skips provider setup for internal hatches and detached keyless hatches", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: undefined,
        detached: false,
      }),
    ).toBe("skip");
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: null,
        detached: true,
      }),
    ).toBe("skip");
  });

  test("detached hatch with a pre-collected key configures instead of deferring", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: "fireworks",
        guardianAccessToken: "guardian-token",
        detached: true,
        precollectedKey: "fw-key-123",
      }),
    ).toBe("configure");
  });

  test("pre-collected key without a guardian token reports missing-token (no silent defer)", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: "fireworks",
        detached: true,
        precollectedKey: "fw-key-123",
      }),
    ).toBe("missing-token");
  });

  test("an explicitly skipped key still counts as answered — configure runs and reports the gap", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: "fireworks",
        guardianAccessToken: "guardian-token",
        detached: true,
        precollectedKey: "",
      }),
    ).toBe("configure");
  });
});

describe("resolveDockerHatchMode", () => {
  test("defaults to pulling published images when no source flag is set", () => {
    expect(
      resolveDockerHatchMode({
        watch: false,
        buildFromSource: false,
        fullSourceTreeAvailable: true,
      }),
    ).toEqual({ build: false, watcher: false, fellBackToPull: false });
  });

  test("--source <path> builds without enabling the file watcher", () => {
    expect(
      resolveDockerHatchMode({
        watch: false,
        buildFromSource: true,
        fullSourceTreeAvailable: true,
      }),
    ).toEqual({ build: true, watcher: false, fellBackToPull: false });
  });

  test("--watch builds and enables the file watcher", () => {
    expect(
      resolveDockerHatchMode({
        watch: true,
        buildFromSource: false,
        fullSourceTreeAvailable: true,
      }),
    ).toEqual({ build: true, watcher: true, fellBackToPull: false });
  });

  test("--watch + --source <path> still enables the watcher (watch wins)", () => {
    expect(
      resolveDockerHatchMode({
        watch: true,
        buildFromSource: true,
        fullSourceTreeAvailable: true,
      }),
    ).toEqual({ build: true, watcher: true, fellBackToPull: false });
  });

  test("falls back to pull when source flag is set but source tree is missing", () => {
    expect(
      resolveDockerHatchMode({
        watch: false,
        buildFromSource: true,
        fullSourceTreeAvailable: false,
      }),
    ).toEqual({ build: false, watcher: false, fellBackToPull: true });
    expect(
      resolveDockerHatchMode({
        watch: true,
        buildFromSource: false,
        fullSourceTreeAvailable: false,
      }),
    ).toEqual({ build: false, watcher: false, fellBackToPull: true });
  });
});

describe("collectWatchTargets", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "cadet-watch-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function scaffold(
    relDir: string,
    { src = true, pkg = true, dockerfile = false } = {},
  ): void {
    mkdirSync(join(repoRoot, relDir), { recursive: true });
    if (src) mkdirSync(join(repoRoot, relDir, "src"), { recursive: true });
    if (pkg) writeFileSync(join(repoRoot, relDir, "package.json"), "{}");
    if (dockerfile) writeFileSync(join(repoRoot, relDir, "Dockerfile"), "");
  }

  test("scopes watch targets to src/, package.json, and the Dockerfile", () => {
    // GIVEN the three services (each with a Dockerfile) plus a couple of
    // shared packages (libraries, no Dockerfile)
    scaffold("assistant", { dockerfile: true });
    scaffold("credential-executor", { dockerfile: true });
    scaffold("gateway", { dockerfile: true });
    scaffold("packages/service-contracts");
    scaffold("packages/local-mode");

    // WHEN we collect the watch targets
    const { dirs, files } = collectWatchTargets(repoRoot);

    // THEN only the src/ directories are watched recursively
    expect(dirs.sort()).toEqual(
      [
        join(repoRoot, "assistant", "src"),
        join(repoRoot, "credential-executor", "src"),
        join(repoRoot, "gateway", "src"),
        join(repoRoot, "packages", "local-mode", "src"),
        join(repoRoot, "packages", "service-contracts", "src"),
      ].sort(),
    );

    // AND the package.json manifests and service Dockerfiles are watched as
    // individual files (packages have no Dockerfile, so none is emitted)
    expect(files.sort()).toEqual(
      [
        join(repoRoot, "assistant", "package.json"),
        join(repoRoot, "assistant", "Dockerfile"),
        join(repoRoot, "credential-executor", "package.json"),
        join(repoRoot, "credential-executor", "Dockerfile"),
        join(repoRoot, "gateway", "package.json"),
        join(repoRoot, "gateway", "Dockerfile"),
        join(repoRoot, "packages", "local-mode", "package.json"),
        join(repoRoot, "packages", "service-contracts", "package.json"),
      ].sort(),
    );
  });

  test("never watches .claude/ command symlinks that crash the watcher", () => {
    // GIVEN an assistant service whose .claude/commands holds a dangling
    // symlink (as it does in a fresh checkout)
    scaffold("assistant");
    mkdirSync(join(repoRoot, "assistant", ".claude", "commands"), {
      recursive: true,
    });
    symlinkSync(
      join(repoRoot, "does-not-exist", "do.md"),
      join(repoRoot, "assistant", ".claude", "commands", "do.md"),
    );

    // WHEN we collect the watch targets
    const { dirs, files } = collectWatchTargets(repoRoot);

    // THEN no watched path reaches into the .claude/ tree
    const all = [...dirs, ...files];
    expect(all.some((p) => p.includes(".claude"))).toBe(false);
    expect(dirs).toContain(join(repoRoot, "assistant", "src"));
  });

  test("skips roots missing a src/ directory or package.json", () => {
    // GIVEN a service with only a manifest and a package with only a src/ dir
    scaffold("gateway", { src: false, pkg: true });
    scaffold("packages/contracts-only", { src: true, pkg: false });

    // WHEN we collect the watch targets
    const { dirs, files } = collectWatchTargets(repoRoot);

    // THEN absent paths are not emitted
    expect(dirs).toEqual([join(repoRoot, "packages", "contracts-only", "src")]);
    expect(files).toEqual([join(repoRoot, "gateway", "package.json")]);
  });
});
