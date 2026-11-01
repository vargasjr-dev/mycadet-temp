import { execOutput } from "../../exec";
import { GATEWAY_INTERNAL_PORT } from "../../ports";
import type { PairOperationResult } from "../../operations/pair";
import { dockerResourceNames } from "./retire";

/**
 * Pair from INSIDE the gateway container (docker topology): the published
 * gateway port is LAN-reachable, so a host-side request arrives from the
 * docker bridge IP and the pair route's loopback guard would refuse it.
 * Docker-exec'ing the pair onto the container's own loopback is the presence
 * proof — the same hatch participation the bootstrap secret used to attest.
 * The exec'd script prints the HTTP status on the first stdout line, the
 * JSON body after. Exec-level failures (docker down, container gone) throw;
 * a answered-but-refused pair comes back structured.
 */
export async function pairDocker(
  instanceName: string,
  body: string,
): Promise<PairOperationResult> {
  const container = dockerResourceNames(instanceName).gatewayContainer;
  const script = [
    `const res = await fetch("http://127.0.0.1:${GATEWAY_INTERNAL_PORT}/v1/pair", {`,
    `  method: "POST",`,
    `  headers: { "content-type": "application/json", "x-cadet-interface-id": "cli" },`,
    `  body: ${JSON.stringify(body)},`,
    `});`,
    `const text = await res.text();`,
    `console.log(res.status);`,
    `console.log(text);`,
  ].join("\n");
  const output = await execOutput(
    "docker",
    ["exec", container, "bun", "-e", script],
    {
      timeoutMs: 30_000,
    },
  );
  const newline = output.indexOf("\n");
  const status = Number(output.slice(0, newline).trim());
  const payload = output.slice(newline + 1);
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    return {
      ok: false,
      status: Number.isInteger(status) ? status : 0,
      error: payload,
    };
  }
  return { ok: true, response: JSON.parse(payload) };
}
