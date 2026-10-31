# Desktop-QA sandbox image for Baseten.
#
# A QA toolbox, not a cadet image: nothing hatches, nothing wakes. The image
# carries the toolchain for headless desktop QA — Xvfb, the Electron runtime
# deps, bun — plus the open-source repo pulled at build time, and QA itself
# is performed through the sandbox (the sandbox-api control plane) by
# building and driving the client under test inside it.
#
# Build & push from the repo root:
#   bun clients/linux/qa/index.ts image push
#
# The mac-only QA tier (keychain, notarized install, auto-update feed,
# native notifications) cannot run here — this image covers everything the
# Linux client shares with the mac build (see clients/linux/qa/index.ts).

# Pin the base by digest (house convention — see cli/src/lib/sandboxes/baseten/Dockerfile).
FROM debian:trixie-slim@sha256:4ffb3a1511099754cddc70eb1b12e50ffdb67619aa0ab6c13fcd800a78ef7c7a

# curl fetches the bun installer; git moves the pulled repo between refs;
# jq/openssl are conveniences the assistant and its skills expect.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq openssl \
  && rm -rf /var/lib/apt/lists/*

# The QA toolbox: Xvfb is the headless display; libgtk/nss/asound/gbm/X11
# client libs are what linux Electron builds link against; ripgrep, procps,
# iproute2, lsof and less are what a QA session reaches for when a run
# misbehaves and someone needs to look around inside the sandbox.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      xvfb libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxrandr2 \
      libxcomposite1 libxdamage1 libxkbcommon0 libpango-1.0-0 libcairo2 \
      libatspi2.0-0 libcups2 libdrm2 \
      ripgrep procps iproute2 lsof less \
  && rm -rf /var/lib/apt/lists/*

# Bun — the version the release pipeline pins (see .github/workflows/release.yml).
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v1.3.11"
ENV PATH="/usr/local/bin:${PATH}"

# Baseten requires the sandbox API server in every image; the entrypoint
# starts it. Pinned to the digest current at authoring time — re-pin
# deliberately when refreshing the image.
COPY --from=ghcr.io/blaxel-ai/sandbox@sha256:8ebb596be14ed4c48f6fe4352e9d3de45dc31634dbca2194293187f54aba8647 \
  /sandbox-api /usr/local/bin/sandbox-api

# The open-source repo, pulled at build time into the QA workspace — the
# runs build the client under test from this tree (fetching the ref they
# name, when they name one).
# https://github.com/vargasjr-dev/mycadet-temp.git
RUN git clone https://github.com/vargasjr-dev/mycadet-temp.git /qa

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /qa
ENTRYPOINT ["/entrypoint.sh"]
