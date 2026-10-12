# Plugin Marketplace

The installable plugin catalog lives in Cadet Cloud (`GET /v1/plugins/`).
Each row has one source:

- `github` identifies an immutable repository commit and an optional package
  path.
- `local` identifies an exact package path and version embedded in the
  assistant distribution. It never resolves a path from the workspace or the
  process working directory.

The assistant merges the local packages it ships into the cloud response,
with cloud rows winning duplicate names. Platform errors fail the catalog
request and are never replaced by a stale or offline response. With platform
features disabled there is no catalog: installs by name need the cloud, and
installs by GitHub URL keep working.

Default plugins live in this repo as plain directories
(`plugins/mcp-catalog/<name>/` — `plugin.json` plus an optional
`integration.json`); there is no central catalog file.
`assistant/scripts/generate-bundled-plugin-packages.ts` scans those
directories, validates every local package, and generates both the embedded
file map used by the installer and the catalog manifest the CLI merges. A
local package must be a standard plugin with matching name and version, a
valid `mcp.json`, canonical paths, and no symlinks. Build and Docker packaging
fail if any package is invalid or unavailable.

The normal plugin installer handles both source kinds and records the exact
source in the install sidecar. Local update checks only versions embedded in
the running assistant and keeps the installed package path fixed. A catalog
source change requires an explicit reinstall, so an update cannot silently
move an existing install between GitHub and the assistant bundle.
