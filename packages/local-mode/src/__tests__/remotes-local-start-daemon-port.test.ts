import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { awaitStartingSentinel } from "../remotes/local/common";

// No mock.module here — bun shares one loader across every test file in the
// process, and a global daemon-port probe spy leaks into suites that run
// after this one. The law holds structurally instead: the start path does
// not even import a probe to call, and the sentinel's handoff is tested
// against real files.

test("the start path never imports a daemon-port probe", async () => {
  /**
   * The daemon's HTTP port is the daemon's own bind address (on its way to
   * IPC-only). The operator layer's liveness signal is the pid file, and the
   * cadet's health is the gateway's to answer — so the start path must not
   * so much as import an HTTP probe to aim at the daemon.
   */

  // GIVEN the start path's source
  const commonSource = readFileSync(
    join(import.meta.dir, "../remotes/local/common.ts"),
    "utf-8",
  );

  // THEN no daemon-port probe helper is imported or called anywhere in it.
  // (findPidListeningOnPort stays: port-heal reads WHO HOLDS a disputed
  // port — an OS ownership question, never a daemon health question.)
  for (const probe of [
    "httpHealthCheck",
    "resolveProcessState",
    "waitForDaemonMigrationsReady",
    "reportFreshSpawnReadiness",
  ]) {
    expect(commonSource.includes(probe)).toBe(false);
  }
});

test("a concurrent spawner's sentinel hands off without probing the port", async () => {
  /**
   * The "starting" sentinel is a handoff, not a readiness wait: the spawner
   * that wrote it replaces it with its real pid the moment spawn() returns,
   * and the start that observes the handoff stands down — no readiness is
   * waited out, because no daemon port is ever probed.
   */

  // GIVEN a concurrent spawner wrote the sentinel...
  const instanceDir = mkdtempSync(
    join(tmpdir(), "cadet-start-daemon-port-sentinel-"),
  );
  const pidFile = join(instanceDir, "daemon.pid");
  writeFileSync(pidFile, "starting", "utf-8");
  // ...and its real pid replaces it the moment spawn() returns
  const daemon = Bun.spawn(["sleep", "5"]);
  setTimeout(() => writeFileSync(pidFile, String(daemon.pid), "utf-8"), 300);

  // WHEN the sentinel is awaited
  const ownedByConcurrentSpawner = await awaitStartingSentinel(pidFile);

  // THEN the handoff is honored
  expect(ownedByConcurrentSpawner).toBe(true);
  daemon.kill();
});

test("a stale sentinel reads as a dead spawner and is taken over", async () => {
  /**
   * A sentinel that never resolves into a pid was written by a spawner that
   * died before its spawn: the pid file is cleaned up so this start can
   * proceed instead of wedging the instance forever.
   */

  // The settle bound is 15s — the poll resolves the moment the sentinel
  // vanishes, so simulate the dead spawner by removing it mid-wait.
  const instanceDir = mkdtempSync(
    join(tmpdir(), "cadet-start-daemon-port-stale-"),
  );
  const pidFile = join(instanceDir, "daemon.pid");
  writeFileSync(pidFile, "starting", "utf-8");
  setTimeout(() => {
    try {
      unlinkSync(pidFile);
    } catch {}
  }, 300);

  const ownedByConcurrentSpawner = await awaitStartingSentinel(pidFile);

  expect(ownedByConcurrentSpawner).toBe(false);
});
