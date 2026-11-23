#!/usr/bin/env bash
set -euo pipefail

release_tag="${1:?release tag required}"
notes_file="${2:?notes output file required}"
: "${GH_REPO:?repository required}"
: "${GITHUB_SHA:?commit required}"

# Preserve prepared notes (e.g. the production AI summary). Generate notes
# separately from release creation so GitHub's body limit can be enforced.
if [ ! -s "$notes_file" ]; then
  if ! gh api "repos/$GH_REPO/releases/generate-notes" \
    -f "tag_name=$release_tag" -f "target_commitish=$GITHUB_SHA" \
    --jq .body > "$notes_file"; then
    echo "::warning::Unable to generate release notes; using release metadata"
    printf 'Release %s from commit %s.\n' "$release_tag" "$GITHUB_SHA" > "$notes_file"
  fi
fi

python3 - "$notes_file" "$GH_REPO" "$GITHUB_SHA" <<'PY'
import pathlib
import sys

file = pathlib.Path(sys.argv[1])
body = file.read_text()
# Stay below GitHub's 125,000-character limit, even if counted as UTF-8 bytes.
limit = 120_000
if len(body.encode("utf-8")) > limit:
    suffix = f"\n\nNotes truncated. [Full commit history](https://github.com/{sys.argv[2]}/commits/{sys.argv[3]}).\n"
    budget = limit - len(suffix.encode("utf-8"))
    body = body.encode("utf-8")[:budget].decode("utf-8", errors="ignore") + suffix
    print("::notice::Release notes exceeded GitHub's limit and were shortened")
file.write_text(body)
PY
