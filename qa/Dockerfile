# Cadet-QA sandbox image for Baseten — ONE image for every client scenario.
#
# A QA toolbox, not a cadet image: nothing hatches, nothing wakes. The image
# carries the shared toolchain, the desktop/browser runtime, the Android SDK,
# and bun; the create mounts the cadet-qa volume (the repo tree) at /qa. A
# session created from it can QA desktop, Android, or web — or just work in
# the tree.
#
# Build & push from the repo root:
#   bun qa/index.ts image push
#
# The Android SDK layer is deliberately best-effort: Baseten's image builder
# cannot reach dl.google.com today ("IO exception while downloading
# manifest"), so the step that fetches Google's packages tolerates failure —
# when it fails, the layer records why in /opt/android-sdk/SDK-UNAVAILABLE
# and the image still builds. Desktop and web QA are unaffected; the Android
# scenario fails at run time with that marker until the layer rebuilds
# somewhere with egress.

# Pin the base by digest (house convention — see cli/src/lib/sandboxes/baseten/Dockerfile).
FROM debian:trixie-slim@sha256:4ffb3a1511099754cddc70eb1b12e50ffdb67619aa0ab6c13fcd800a78ef7c7a

# Shared plumbing: curl fetches the bun installer; unzip unpacks archives;
# git is there for sessions (clone, checkout, diffs); jq/openssl are conveniences the
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
# it xvfb-run refuses to start and every desktop run dies at startup).
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

# --- Android layer (best-effort — see the header) ----------------------------
# openjdk-21-jdk-headless is the JDK Capacitor 8's Gradle build requires (see
# clients/android/scripts/dev.ts: "Java 21 is required to run the Android
# app"; CI pins temurin 21 — same JVM, Debian's OpenJDK build). The JDK comes
# from Debian's mirrors, which the builder CAN reach, so it stays
# unconditional; only the dl.google.com step below is tolerated failure.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-21-jdk-headless \
  && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64

# The Android SDK, matching what clients/android targets (compileSdk 36 —
# see clients/android/variables.gradle). google_apis, not the
# google_apis_playstore image dev.ts uses: Play-licensed images refuse adb
# root and add nothing to a QA farm; the dev-machine choice buys store
# parity we don't need here. The command-line tools build is pinned
# (re-pin deliberately when refreshing).
ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${PATH}"

# Everything in this step talks to dl.google.com. When the builder has no
# route there, the `||` records the reason in SDK-UNAVAILABLE and exits 0 —
# the image builds without the SDK instead of failing the build.
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
  && (curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
        -o /tmp/commandlinetools.zip \
      && unzip -q /tmp/commandlinetools.zip -d ${ANDROID_HOME}/cmdline-tools \
      && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
      && rm /tmp/commandlinetools.zip \
      && yes | sdkmanager --licenses > /dev/null \
      && sdkmanager --install \
          "platform-tools" \
          "platforms;android-36" \
          "build-tools;36.0.0" \
          "emulator" \
          "system-images;android-36;google_apis;x86_64" \
      || (printf 'the image builder could not reach dl.google.com — the android packages are missing\n' \
            > ${ANDROID_HOME}/SDK-UNAVAILABLE \
          && echo "[qa image] android SDK unavailable (no route to dl.google.com at build time); android QA fails until this layer rebuilds somewhere with egress"))

# --- Bun ---------------------------------------------------------------------
# The version the release pipeline pins (see .github/workflows/release.yml).
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v1.3.11"
ENV PATH="/usr/local/bin:${PATH}"

# Baseten requires the sandbox API server in every image; the entrypoint
# starts it. Pinned to the digest current at authoring time — re-pin
# deliberately when refreshing the image.
COPY --from=ghcr.io/blaxel-ai/sandbox@sha256:8ebb596be14ed4c48f6fe4352e9d3de45dc31634dbca2194293187f54aba8647 \
  /sandbox-api /usr/local/bin/sandbox-api

# The QA workspace itself is NOT in the image: every create mounts the
# cadet-qa volume (the assembled repo tree) at /qa, which shadows anything a
# build-time clone would leave here. /qa just has to exist for WORKDIR.
RUN mkdir -p /qa

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /qa
ENTRYPOINT ["/entrypoint.sh"]
