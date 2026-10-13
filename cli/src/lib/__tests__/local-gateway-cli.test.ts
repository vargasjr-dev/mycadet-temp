import { describe, expect, test } from "bun:test";

import type { LocalInstanceResources } from "../assistant-config.js";
import { gatewayCliInvocation } from "../local.js";

function fakeResources(instanceDir: string): LocalInstanceResources {
  // gatewayCliInvocation only reads instanceDir; the rest of the resources
  // shape is irrelevant here.
  return { instanceDir } as unknown as LocalInstanceResources;
}

describe("gatewayCliInvocation", () => {
  test("runs the gateway package's CLI entry through bun", () => {
    const invocation = gatewayCliInvocation();
    expect(invocation.args[0]).toBe("run");
    expect(invocation.args[1]).toMatch(/gateway\/src\/cli\/index\.ts$/);
  });

  test("pins CADET_WORKSPACE_DIR to the instance dir for named instances", () => {
    const invocation = gatewayCliInvocation(
      fakeResources("/data/assistants/testy"),
    );
    expect(invocation.env.CADET_WORKSPACE_DIR).toBe(
      "/data/assistants/testy/workspace",
    );
  });

  test("pins GATEWAY_SECURITY_DIR to the instance dir for named instances", () => {
    const invocation = gatewayCliInvocation(
      fakeResources("/data/assistants/testy"),
    );
    expect(invocation.env.GATEWAY_SECURITY_DIR).toBe(
      "/data/assistants/testy/gateway-security",
    );
  });

  test("leaves the workspace resolution untouched for the default instance", () => {
    delete process.env.CADET_WORKSPACE_DIR;
    const invocation = gatewayCliInvocation();
    expect(invocation.env.CADET_WORKSPACE_DIR).toBeUndefined();
  });
});
