import { execOutput } from "../../exec";
import type {
  PairDeviceIdentity,
  PairOperationResult,
} from "../../operations/pair";
import { pairCliStdoutToResult } from "../../operations/pair";
import type { LocalAssistant } from "../../lockfile-contract";
import type { GuardianTokenData } from "../../guardian-token";
import { GuardianTokenFileSchema } from "../../guardian-token";
import { getLocalInstanceDir } from "./instance";
import { join } from "node:path";

/**
 * The gateway subcommand's spawn context — the SAME geography `cadet exec
 * --service gateway` gives the gateway's own CLI (cwd = the instance's
 * gateway-security dir), resolved through the instance's `bin/gateway`
 * shim so the mint runs the identical gateway build the daemon runs, with
 * the instance-pinned CADET_WORKSPACE_DIR / GATEWAY_SECURITY_DIR the
 * server was given (the file-backed pairing store must resolve identically
 * in both processes). Inlined at its single caller: this is pair-local
 * plumbing, not shared machinery.
 */
function gatewayPairInvocation(entry: LocalAssistant): {
  cwd: string;
  env: Record<string, string | undefined>;
} {
  const root = getLocalInstanceDir(entry);
  const gatewaySecurityDir = join(root, "gateway-security");
  return {
    // The instance's bin/ shim for `gateway` (materialized by the env
    // build every hatch/wake/exec runs) — a layer removed from bun, so
    // the shim's own source resolution governs which gateway runs.
    cwd: gatewaySecurityDir,
    env: {
      ...process.env,
      CADET_WORKSPACE_DIR: join(root, "workspace"),
      GATEWAY_SECURITY_DIR: gatewaySecurityDir,
      // The shim lives in the instance's bin/ — put it first on PATH so
      // the bare `gateway` command resolves to THIS instance's build.
      PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
    },
  };
}

/**
 * Pair by running the gateway's OWN CLI on this host (local topology): the
 * `gateway pairing mint` command, invoked in-process — process execution is
 * the local-presence proof, and the invocation resolves the same workspace
 * and gateway security dir as the locally spawned gateway server. No HTTP,
 * no loopback.
 *
 * With a device identity the mint carries the --device-id flags and the
 * result parses to the pair payload (single-line JSON, persisted by the
 * caller). Without one it is the bare remote-web challenge mint the
 * `cadet pair` command wraps — the command's raw stdout, whose last line
 * is the challenge JSON.
 */
export function pairLocal(entry: LocalAssistant): Promise<string>;
export function pairLocal(
  entry: LocalAssistant,
  device: PairDeviceIdentity,
): Promise<PairOperationResult<GuardianTokenData>>;
export async function pairLocal(
  entry: LocalAssistant,
  device?: PairDeviceIdentity,
): Promise<string | PairOperationResult<GuardianTokenData>> {
  const invocation = gatewayPairInvocation(entry);
  const args = ["pairing", "mint"];
  if (device) {
    args.push(
      "--platform",
      device.platform,
      "--device-id",
      device.deviceId,
      ...(device.clientReportedName
        ? ["--client-reported-name", device.clientReportedName]
        : []),
    );
  }
  try {
    const stdout = await execOutput("gateway", args, {
      cwd: invocation.cwd,
      env: invocation.env,
      timeoutMs: 30_000,
    });
    return device
      ? pairCliStdoutToResult(stdout, GuardianTokenFileSchema)
      : stdout;
  } catch (err) {
    if (!device) throw err;
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
