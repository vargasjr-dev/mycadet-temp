# Desktop-QA sandbox image for Baseten.
#
# The sandbox runs the LINUX DESKTOP CLIENT headless against the full Cadet
# stack: Xvfb provides the display, the published `mycadet` npm package
# provides the daemon/gateway/web the client talks to, and the client under
# test is built inside the sandbox from the git ref the QA run checks out —
# the image carries the toolchain, not the artifacts, so a QA run always
# exercises the PR's actual code.
#
# Build & push from the repo root:
#   bun clients/linux/qa/index.ts image push
#
# Credentials never bake into the image — pass them at create time:
#   bun clients/linux/qa/index.ts create --name qa-<pr> --env BASETEN_API_KEY=...
#
# The mac-only QA tier (keychain, notarized install, auto-update feed,
# native notifications) cannot run here — this image covers everything the
# Linux client shares with the mac build (see clients/linux/qa/index.ts).

# Pin the base by digest (house convention — see cli/src/lib/sandboxes/baseten/Dockerfile).
FROM debian:trixie-slim@sha256:4ffb3a1511099754cddc70eb1b12e50ffdb67619aa0ab6c13fcd800a78ef7c7a

# curl fetches the bun installer; git fetches the ref under test; jq/openssl
# are runtime conveniences the assistant and its skills expect.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq openssl \
  && rm -rf /var/lib/apt/lists/*

# Xvfb is the headless display; the rest are the Electron runtime deps
# (GTK, NSS, ALSA, GBM, X11 client libs) linux Electron builds link against.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      xvfb libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxrandr2 \
      libxcomposite1 libxdamage1 libxkbcommon0 libpango-1.0-0 libcairo2 \
      libatspi2.0-0 libcups2 libdrm2 \
  && rm -rf /var/lib/apt/lists/*

# Bun — the version the release pipeline pins (see .github/workflows/release.yml).
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v1.3.11"

# Baseten requires the sandbox API server in every image; the entrypoint
# starts it. Pinned to the digest current at authoring time — re-pin
# deliberately when refreshing the image.
COPY --from=ghcr.io/blaxel-ai/sandbox@sha256:8ebb596be14ed4c48f6fe4352e9d3de45dc31634dbca2194293187f54aba8647 \
  /sandbox-api /usr/local/bin/sandbox-api

# The published stack: `cadet`/`gateway`/`assistant` bins on PATH plus every
# runtime package — the daemon/gateway/web side the desktop client proxies to.
# (PATH fix from #626: bun's global bin dir is not on Debian's default PATH.)
ARG MYCADET_VERSION=0.13.0
ENV PATH="/root/.bun/bin:${PATH}"
RUN bun add -g "mycadet@${MYCADET_VERSION}"

# Runtime sources the CLI's daemon/gateway/CES resolvers can find — the same
# /app-as-source-tree shape as the cadet sandbox image.
WORKDIR /app
RUN printf '{"private":true,"dependencies":{"mycadet":"%s"}}\n' "${MYCADET_VERSION}" > package.json \
  && bun install --ignore-scripts \
  && ln -s node_modules/@mycadet/assistant assistant \
  && ln -s node_modules/@mycadet/gateway gateway \
  && ln -s node_modules/@mycadet/credential-executor credential-executor

# Hatch the golden assistant: lockfile entry, workspace, signing identity and
# first-boot migrations bake into the image. The build runs headless, so the
# provider/API-key prompts are skipped.
RUN cd /app && cadet hatch --name cadet --remote local

# The client under test and the QA scenarios are checked out per run into
# /qa (git fetch the ref, install, build, xvfb-run the scenarios).
RUN mkdir -p /qa

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /app
ENTRYPOINT ["/entrypoint.sh"]
