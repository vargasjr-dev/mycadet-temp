import { expect, test } from "bun:test";

import * as index from "./index";

/**
 * The index is the package's public door. Lifecycle primitives (start/stop/
 * restart) stay private to the local lifecycle legs — callers converge on
 * the operations (`wakeAssistant`/`sleepAssistant`), per review on #668.
 * Runs in pr-local-mode's Type Check & Test job.
 */
test("the index exports no NEW lifecycle primitives — operations are the door", () => {
  const lifecyclePrimitive = /^(start|stop|restart)[A-Z]/;
  // Grandfathered infrastructure primitives the CLI drives directly (docker
  // provisioning, the nginx edge, tunnel process teardown) — NOT operation
  // internals. New entries here need a review argument, not a list edit.
  const infraExceptions = new Set([
    "startColimaAndAwaitDaemon",
    "stopContainerAppServer",
    "stopIngressNginx",
    "stopProcess",
    "stopProcessByPidFile",
    "stopProcessGracefully",
  ]);
  const offenders = Object.keys(index).filter(
    (key) => lifecyclePrimitive.test(key) && !infraExceptions.has(key),
  );
  expect(offenders).toEqual([]);
});
