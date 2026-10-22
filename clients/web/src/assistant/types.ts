/**
 * What the web bundle's one assistant resolution landed on.
 *
 * The web bundle is focused on a single assistant whose auth is constant at
 * initial iframe load, so there is no runtime state machine to manage — no
 * retry budgets, no watchdogs, no reachability polling. This state only
 * changes when the boot resolution query refetches (selection change, retry,
 * the poll while a transient phase is expected to resolve).
 *
 * `loading` is the client-only initial phase before any `/assistant/`
 * response has resolved. Every other kind maps from
 * `resolveAssistantLifecycleState` of a server response (or the gateway-auth
 * short-circuit, which resolves `active` locally).
 */
export type AssistantResolutionState =
  | { kind: "loading" }
  | { kind: "initializing" }
  | { kind: "cleaning_up" }
  | { kind: "self_hosted" }
  | { kind: "active"; isLocal: boolean }
  | { kind: "auto_hatch" }
  | { kind: "error"; message: string; transient?: boolean };
