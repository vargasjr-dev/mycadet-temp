/**
 * Shared tail for errors where this CLI doesn't recognize an option or provider
 * the user named. The name may be valid in a newer release, so point the user
 * at the self-update path before they conclude the feature doesn't exist.
 *
 * `bun install -g cadet@latest` refreshes the `cadet` binary directly — the
 * mechanism the installer and the CLI's own self-update use. (`cadet upgrade`
 * targets the assistant runtime, not the CLI binary, for local assistants.)
 */
export const STALE_CLI_UPDATE_HINT =
  "your CLI may be out of date — update it with `bun install -g cadet@latest` and retry.";
