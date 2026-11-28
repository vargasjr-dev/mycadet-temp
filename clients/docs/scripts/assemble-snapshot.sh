#!/usr/bin/env bash
# Assembles the marketing snapshot artifact from a built docs app:
# every prerendered page, the public assets under the /docs ingress
# prefix, the content-hashed chunks, and the VERSION marker.
set -euo pipefail

SITE=docs-frontend-site
mkdir -p "$SITE/_next"
# Every prerendered page the cloud web twin serves from the bucket: a
# glob, so a future page can't be forgotten. The /plugins/[name] detail
# pages are dynamic — they stay on the docs-site service.
cp clients/docs/.next/server/app/*.html "$SITE/"
# The not-found page publishes under its fallback name (the mirror
# serves it when a bucket path misses).
if [ -f "$SITE/_not-found.html" ]; then
  mv "$SITE/_not-found.html" "$SITE/404.html"
fi
# Public assets land at SITE/docs/ so the object paths match the URLs
# that reference them. The page tree above already created SITE/docs,
# so copy the CONTENTS in: a plain `cp -R public/docs SITE/docs` would
# nest a second docs/ inside and every asset would 404 one level deep.
cp -R clients/docs/public/docs/. "$SITE/docs/"
# Content-hashed client chunks, referenced as /docs/_next/* (the app's
# assetPrefix). Uploaded append-only bucket-side so older builds'
# references keep resolving.
cp -R clients/docs/.next/static "$SITE/_next/"
echo "$GITHUB_SHA" > "$SITE/VERSION"
