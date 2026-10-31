// The loopback-safe fetch (Bun's socket pooling breaks loopback keepalive)
// lives in `@mycadet/local-mode` now — the operations share it. Re-exported
// for this module's consumers.
export { isLoopbackUrl, loopbackSafeFetch } from "@mycadet/local-mode";
