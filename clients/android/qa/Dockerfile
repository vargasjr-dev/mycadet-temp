# Android-QA sandbox image for Baseten.
#
# A QA toolbox, not a cadet image: nothing hatches, nothing wakes. The image
# carries the ANDROID toolchain — JDK 21, the Android SDK (platform 36,
# build-tools 36.0.0), the emulator, platform-tools (adb) — plus bun and the
# open-source repo pulled at build time. QA is performed through the sandbox
# (the sandbox-api control plane) by building clients/android inside it and
# driving the APK on a headless emulator (see ./index.ts, ./scripts/).
#
# KVM reality: Baseten sandboxes are Firecracker microVMs, which expose no
# nested virtualization, so /dev/kvm is absent and the emulator runs in QEMU
# TCG (software emulation) — a boot takes minutes, not seconds, and UI
# interaction is sluggish. The scripts are written for that posture; if a
# host ever exposes /dev/kvm the emulator picks acceleration up on its own.
#
# The mac-only tier of the desktop image (keychain, notarized install) has
# an Android analogue that cannot run here either: nothing in this image
# talks to Google Play, so Play-licensing behavior of a store build is out
# of scope (see clients/android/qa/README.md).
#
# Build & push from the repo root:
#   bun clients/android/qa/index.ts image push

# Pin the base by digest (house convention — see clients/linux/qa/Dockerfile).
FROM debian:trixie-slim@sha256:4ffb3a1511099754cddc70eb1b12e50ffdb67619aa0ab6c13fcd800a78ef7c7a

# openjdk-21-jdk-headless is the JDK Capacitor 8's Gradle build requires
# (see clients/android/scripts/dev.ts: "Java 21 is required to run the
# Android app"). curl fetches the Android cmdline-tools zip and the bun
# installer; unzip unpacks the tools; git moves the pulled repo between
# refs; the rest are conveniences a QA session reaches for when a run
# misbehaves and someone needs to look around inside the sandbox.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      openjdk-21-jdk-headless ca-certificates curl git jq unzip \
      ripgrep procps iproute2 lsof less \
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

# Bun — the version the release pipeline pins (see .github/workflows/release.yml).
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v1.3.11"
ENV PATH="/usr/local/bin:${PATH}"

# Baseten requires the sandbox API server in every image; the entrypoint
# starts it. Pinned to the digest current at authoring time — re-pin
# deliberately when refreshing the image. (Digest shared with the
# desktop-QA image; see clients/linux/qa/Dockerfile.)
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
