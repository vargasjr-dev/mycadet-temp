import { cliCommandName } from "@mycadet/local-mode";

/**
 * The binary name the user actually invokes: production keeps the bare
 * `cadet`, while every non-production environment installs as `cadet-<env>`
 * (the same rule as the config and state dirs — see environments/paths.ts).
 * Help text, usage lines, and recovery hints must render THIS name — a
 * hardcoded `cadet` in `cadet-local`'s output tells the user to run a
 * binary that does not exist for them.
 *
 * Delegates to local-mode's `cliCommandName` — the platform seam raises the
 * same `login` recovery hint and both must name the same binary.
 */
export function cliCommand(): string {
  return cliCommandName();
}
