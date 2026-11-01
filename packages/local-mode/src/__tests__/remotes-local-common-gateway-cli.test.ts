import { describe, expect, test } from "bun:test";

import type {
  LocalAssistant,
  DockerAssistant,
  AppleContainerAssistant,
} from "@mycadet/local-mode/contract";
import { gatewayCliInvocation } from "../remotes/local/common";

function fakeEntry(
  instanceDir: string,
): LocalAssistant | DockerAssistant | AppleContainerAssistant {
  // gatewayCliInvocation only reads the recorded paths; the rest of the
  // entry shape is irrelevant here.
  return {
    assistantId: "asst_gateway-cli",
    cloud: "local",
    instanceDir,
    port: 0,
    daemonPort: 0,
  };
}

describe("gatewayCliInvocation", () => {
  test("runs the gateway package's CLI entry through bun", () => {
    const invocation = gatewayCliInvocation();
    expect(invocation.args[0]).toBe("run");
    expect(invocation.args[1]).toMatch(/gateway\/src\/cli\/index\.ts$/);
  });

  test("pins CADET_WORKSPACE_DIR to the instance dir for named instances", () => {
    const invocation = gatewayCliInvocation(
      fakeEntry("/data/assistants/testy"),
    );
    expect(invocation.env.CADET_WORKSPACE_DIR).toBe(
      "/data/assistants/testy/workspace",
    );
  });

  test("pins GATEWAY_SECURITY_DIR to the instance dir for named instances", () => {
    const invocation = gatewayCliInvocation(
      fakeEntry("/data/assistants/testy"),
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
