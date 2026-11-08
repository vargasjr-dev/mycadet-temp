# Cadet-QA sandbox image for Baseten.
#
# A QA toolbox, not a cadet image: nothing hatches, nothing wakes. This image
# (the default) carries what the desktop and web scenarios need. The Android
# emulator scenario needs the SDK layer, which only builds where the builder
# can reach dl.google.com — Baseten's builder cannot ("IO exception while
# downloading manifest"), so it lives in ./Dockerfile.android: build it where
# Google's repository is reachable and bring it over with
#   baseten sandbox image push --name cadet-qa-android --registry-image <ref>
# (Baseten's push has no --build-arg flag, so a per-variant Dockerfile is the
# split that works with the platform).
#
# A single sandbox still QAs anything the image carries, and — since the image
# pulls the repo into /qa and the control plane is a general process/
# filesystem API — a session can hop between targets without a rebuild.
#
# Build & push from the repo root:
#   bun qa/index.ts image push

# Pin the base by digest (house convention — see cli/src/lib/sandboxes/baseten/Dockerfile).
FROM debian:trixie-slim@sha256:4ffb3a1511099754cddc70eb1b12e50ffdb67619aa0ab6c13fcd800a78ef7c7a

# Shared plumbing: curl fetches the bun installer; unzip unpacks archives;
# git moves the pulled repo between refs; jq/openssl are conveniences the
# assistant and its skills expect; ripgrep/procps/iproute2/lsof/less are
# what a QA session reaches for when a run misbehaves and someone needs to
# look around inside the sandbox.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq openssl unzip \
      ripgrep procps iproute2 lsof less \
  && rm -rf /var/lib/apt/lists/*

# --- Desktop + browser layer ------------------------------------------------
# Xvfb is the headless display (xauth is xvfb-run's own dependency — without
# it xvfb-run refuses to start and every desktop scenario dies at startup).
# The libgtk/nss/asound/gbm/X11 client libs are what linux Electron builds
# link against — the same set Chromium (Playwright) needs plus
# libnspr4/libatk/libxfixes3/libdbus, so web-scenario browser tests run on
# the same layer. No separate browser download here: the repo's own
# @playwright/browser-chromium (root package.json) provides the browser
# binary.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      xvfb xauth libgtk-3-0 libnss3 libnspr4 libasound2 libgbm1 libxss1 \
      libxrandr2 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 \
      libpango-1.0-0 libcairo2 libatspi2.0-0 libcups2 libdrm2 \
      libatk1.0-0 libatk-bridge2.0-0 libdbus-1-3 \
  && rm -rf /var/lib/apt/lists/*

# --- Bun ---------------------------------------------------------------------
# The version the release pipeline pins (see .github/workflows/release.yml).
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v1.3.11"
ENV PATH="/usr/local/bin:${PATH}"

# Baseten requires the sandbox API server in every image; the entrypoint
# starts it. Pinned to the digest current at authoring time — re-pin
# deliberately when refreshing the image.
COPY --from=ghcr.io/blaxel-ai/sandbox@sha256:8ebb596be14ed4c48f6fe4352e9d3de45dc31634dbca2194293187f54aba8647 \
  /sandbox-api /usr/local/bin/sandbox-api

# The open-source repo, pulled at build time into the QA workspace — the
# runs build the client under test from this tree (fetching the ref they
# name, when they name one). This is also what makes the sandbox a place
# you can work rather than just run: a session exec's into /qa with no
# local clone involved anywhere.
# https://github.com/vargasjr-dev/mycadet-temp.git
RUN git clone https://github.com/vargasjr-dev/mycadet-temp.git /qa

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /qa
ENTRYPOINT ["/entrypoint.sh"]
