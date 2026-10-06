/**
 * @mycadet/ces-client
 *
 * Shared CES HTTP and RPC client package for assistant and gateway
 * service-to-service communication with the Credential Execution Service.
 *
 * Sub-module exports:
 * - `@mycadet/ces-client/http-credentials` — credential CRUD over CES HTTP
 * - `@mycadet/ces-client/http-log-export`  — CES log export over HTTP
 * - `@mycadet/ces-client/rpc-client`       — CES RPC envelope/handshake client
 */

export {
  createCesHttpCredentialClient,
  type CesHttpCredentialClient,
  type CesHttpCredentialConfig,
  type CesHttpLogger,
  type CesCredentialGetResult,
  type CesCredentialListResult,
  type CesDeleteResult,
  type CredentialRecord,
} from "./http-credentials.js";

export {
  fetchCesLogExport,
  type CesLogExportConfig,
  type CesLogExportOptions,
  type CesLogExportResult,
  type CesLogExportSuccess,
  type CesLogExportFailure,
} from "./http-log-export.js";

export {
  createCesRpcClient,
  CesClientError,
  CesTransportError,
  CesHandshakeError,
  CesTimeoutError,
  CesRpcError,
  type CesTransport,
  type CesRpcClient,
  type CesRpcClientConfig,
  type CesRpcHandshakeOptions,
  type CesRpcLogger,
} from "./rpc-client.js";
