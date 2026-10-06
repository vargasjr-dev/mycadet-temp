/**
 * @mycadet/ces-client/credential-rpc
 *
 * Re-exports the credential RPC surface from `@mycadet/service-contracts` so
 * consumers that depend on `@mycadet/ces-client` can access the CES wire
 * protocol types through this package without a separate dependency on
 * `@mycadet/service-contracts`.
 *
 * Prefer importing directly from `@mycadet/service-contracts/credential-rpc`
 * for new code outside of the ces-client boundary.
 */

export * from "@mycadet/service-contracts/credential-rpc";
