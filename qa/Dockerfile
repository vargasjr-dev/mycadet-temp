# Cadet-QA sandbox image for Baseten.
#
# A QA toolbox, not a cadet image: nothing hatches, nothing wakes. ONE image
# for every client-QA need — desktop, Android, web — so a sandbox is a
# complete QA (and, one day, development) environment: the image carries the
# full toolchain below plus the open-source repo pulled at build time, and
# QA is performed through the sandbox (the sandbox-api control plane) by
# building and driving the client under test inside it (see ./index.ts).
#
# Layering everything into one image is deliberate: a single image means a
# single sandbox can QA any target, and a session can hop between them
# without a rebuild. The cost is image size — acceptable, Baseten images are
# built rarely and sandboxes scale to zero.
#
# Build & push from the repo root:
#   bun qa/index.ts image push

# Pin the base by digest (house convention — see cli/src/lib/sandboxes/baseten/Dockerfile).
FROM debian:trixie-slim@sha256:4ffb3a1511099754cddc70eb1b12e50ffdb67619aa0ab6c13fcd800a78ef7c7a

# Shared plumbing: curl fetches the Android cmdline-tools zip and the bun
# installer; unzip unpacks the tools; git moves the pulled repo between
# refs; jq/openssl are conveniences the assistant and its skills expect;
# ripgrep/procps/iproute2/lsof/less are what a QA session reaches for when
# a run misbehaves and someone needs to look around inside the sandbox.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq openssl unzip \
      ripgrep procps iproute2 lsof less \
  && rm -rf /var/lib/apt/lists/*

# --- Desktop + browser layer ------------------------------------------------
# Xvfb is the headless display. The libgtk/nss/asound/gbm/X11 client libs are
# what linux Electron builds link against — the same set Chromium (Playwright)
# needs plus libnspr4/libatk/libxfixes3/libdbus, so web-scenario browser tests
# run on the same layer. No separate browser download here: the repo's own
# @playwright/browser-chromium (root package.json) provides the browser binary.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      xvfb libgtk-3-0 libnss3 libnspr4 libasound2 libgbm1 libxss1 \
      libxrandr2 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 \
      libpango-1.0-0 libcairo2 libatspi2.0-0 libcups2 libdrm2 \
      libatk1.0-0 libatk-bridge2.0-0 libdbus-1-3 \
  && rm -rf /var/lib/apt/lists/*

# --- Android layer -----------------------------------------------------------
# openjdk-21-jdk-headless is the JDK Capacitor 8's Gradle build requires (see
# clients/android/scripts/dev.ts: "Java 21 is required to run the Android
# app"; CI pins temurin 21 — same JVM, Debian's OpenJDK build).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-21-jdk-headless \
  && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64

# The Android SDK, matching what clients/android targets (compileSdk 36 —
# see clients/android/variables.gradle). google_apis, not the
# google_apis_playstore image dev.ts uses: Play-licensed images refuse adb
# root and add nothing to a QA farm; the dev-machine choice buys store
# parity we don't need here.
ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${PATH}"

# Pin the command-line tools build (re-pin deliberately when refreshing) —
# the tools only talk to Google's package repository; any recent build
# understands every package pin below.
RUN curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
      -o /tmp/commandlinetools.zip \
  && mkdir -p ${ANDROID_HOME}/cmdline-tools \
  && unzip -q /tmp/commandlinetools.zip -d ${ANDROID_HOME}/cmdline-tools \
  && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
  && rm /tmp/commandlinetools.zip \
  && yes | sdkmanager --licenses > /dev/null \
  && sdkmanager --install \
      "platform-tools" \
      "platforms;android-36" \
      "build-tools;36.0.0" \
      "emulator" \
      "system-images;android-36;google_apis;x86_64"

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
