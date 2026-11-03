#!/usr/bin/env bash
#
# stamp-dev-meta-package.sh
#
# Stamp a dev-release version into meta/package.json and generate the
# production launcher the dev channel's `cadet`/`mycadet` names run through.
#
# The `cadet`/`mycadet` names on the dev channel run the CLI under production
# conditions: CADET_ENVIRONMENT beats the version-derived environment (a
# dev-release CLI version would resolve "dev" otherwise), and the resolved
# environment propagates to the daemon/gateway children through
# process.env. The launcher is generated here — published in the dev
# tarball only — so the production meta package never carries it.
#
# Usage:
#   ./scripts/stamp-dev-meta-package.sh <version>

set -euo pipefail

VERSION="${1:?usage: stamp-dev-meta-package.sh <version>}"

cd "$(dirname "$0")/../meta"

jq --arg v "$VERSION" '
  .version = $v |
  .bin = { "cadet-dev": .bin.cadet, "cadet": "./bin/cadet-production.js", "mycadet": "./bin/cadet-production.js", "assistant": .bin.assistant, "gateway": .bin.gateway } |
  .dependencies["@mycadet/app"] = $v |
  .dependencies["@mycadet/assistant"] = $v |
  .dependencies["@mycadet/cli"] = $v |
  .dependencies["@mycadet/credential-executor"] = $v |
  .dependencies["@mycadet/gateway"] = $v |
  .dependencies["@mycadet/web"] = $v
' package.json > tmp && mv tmp package.json

mkdir -p bin
cat > bin/cadet-production.js <<'EOF'
#!/usr/bin/env bun
// Dev-channel launcher for the `cadet` and `mycadet` names: force the
// production environment before the CLI evaluates, so a cadet@dev install
// can run on a production assistant and feed stability feedback.
process.env.CADET_ENVIRONMENT = "production";
import("@mycadet/cli");
EOF
