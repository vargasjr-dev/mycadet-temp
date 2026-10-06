/**
 * @mycadet/service-contracts/credential-rpc
 *
 * Domain entrypoint for the CES (Credential Execution Service) transport and
 * RPC surface. Re-exports the transport/RPC/handles/error contracts without
 * the trust-rule helpers.
 *
 * Prefer this subpath over the root `.` import when you only need the
 * credential RPC surface:
 *
 *   import { CesRpcMethod, GetCredentialSchema } from "@mycadet/service-contracts/credential-rpc";
 *
 * For trust-rule types use the dedicated subpath:
 *
 *   import { TrustRule, parseTrustRule } from "@mycadet/service-contracts/trust-rules";
 */

export * from "./transport.js";
export * from "./error.js";
export * from "./handles.js";
export * from "./rpc.js";
