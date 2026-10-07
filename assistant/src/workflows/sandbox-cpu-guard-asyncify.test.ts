import { describe, expect, test } from "bun:test";

import { createWorkflowSandbox } from "./sandbox.js";

// The two long-await CPU-guard reset tests, split out of sandbox.test.ts.
//
// They pass reliably by hand (`bun test src/workflows/sandbox-cpu-guard-asyncify.test.ts`),
// including pinned to 2 cores — but under CI's concurrent per-file workers the
// QuickJS asyncify resume can be starved past the per-test cap and the host
// promise's resumption is lost (the same 0.32.0 asyncify fragility documented
// for sandbox-escape.test.ts, which is in scripts/test.ts KNOWN_BROKEN_FILES
// for exactly this reason). Until that wedge is fixed, these run by hand only;
// the tight-loop deadline test and the memory-guard test still run in CI via
// sandbox.test.ts.
describe("createWorkflowSandbox — CPU guard (long host awaits)", () => {
  // Margins for the two long-await tests below. The host await must exceed the
  // deadline so the reset is load-bearing — without it, the script resumes
  // against an already-expired guard and trips. The deadline itself leaves a
  // full second of post-resume headroom: on shared CI runners, CPU contention
  // can stall the resume path for hundreds of milliseconds, and that stall
  // counts against the contiguous-CPU deadline.
  const LONG_HOST_AWAIT_MS = 1500;
  const LONG_AWAIT_DEADLINE_MS = 1000;

  test("a genuinely long host call does not trip the deadline (latency excused)", async () => {
    // A single host call whose await exceeds the deadline must NOT trip: the
    // reset excuses real leaf/agent latency. With the reset gated on a 50ms
    // threshold, this call still resets.
    const sandbox = createWorkflowSandbox({
      hostFunctions: {
        slow: async () => {
          await new Promise((r) => setTimeout(r, LONG_HOST_AWAIT_MS));
          return "ok";
        },
      },
      interruptDeadlineMs: LONG_AWAIT_DEADLINE_MS,
    });
    const result = await sandbox.run(`return slow();`, null);
    expect(result).toBe("ok");
  });

  test("a host call that REJECTS after a long await still resets the deadline (catch survives)", async () => {
    // A leaf that fails after a long round-trip must not leave the script's
    // catch block resuming against an already-expired CPU deadline. The
    // reject-path reset (finally) excuses the awaited latency on failure too,
    // so the catch — which does enough work to hit an interrupt check — runs
    // instead of being killed as a WorkflowResourceError. Without the reset,
    // this run rejects.
    const sandbox = createWorkflowSandbox({
      hostFunctions: {
        slowFail: async () => {
          await new Promise((r) => setTimeout(r, LONG_HOST_AWAIT_MS));
          throw new Error("leaf failed");
        },
      },
      interruptDeadlineMs: LONG_AWAIT_DEADLINE_MS,
    });
    const result = await sandbox.run(
      `try {
         slowFail();
         return "no-throw";
       } catch (e) {
         let s = 0;
         for (let i = 0; i < 100000; i++) s += i;
         return "caught:" + s;
       }`,
      null,
    );
    expect(String(result).startsWith("caught:")).toBe(true);
  });
});
