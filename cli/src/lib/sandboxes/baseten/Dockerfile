# Cadet sandbox image for Baseten.
#
# The model loop runs IN the sandbox, so this image ships the full Cadet
# stack from the published `mycadet` npm package and hatches a golden
# assistant at build time. Baseten's control plane (processes, filesystem,
# ports) rides on the sandbox-api binary every sandbox image must include.
#
# Build & push from the repo root:
#   baseten sandbox image push --name cadet \
#     --dir cli/src/lib/sandboxes/baseten --wait
#
# Credentials never bake into the image — pass them at create time:
#   baseten sandbox create --name my-cadet --image sandbox/cadet:latest \
#     --env ANTHROPIC_API_KEY=...

# Pin the base by digest (house convention — see assistant/Dockerfile).
FROM debian:trixie-slim@sha256:4ffb3a1511099754cddc70eb1b12e50ffdb67619aa0ab6c13fcd800a78ef7c7a

# curl fetches the bun installer; git/openssl/jq are runtime conveniences the
# assistant and its skills expect. No compilers: the runtime packages ship
# prebuilt and bun runs TypeScript sources directly.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq openssl \
  && rm -rf /var/lib/apt/lists/*

# Bun — the version the release pipeline pins (see .github/workflows/release.yml).
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v1.3.11"

# Baseten requires the sandbox API server in every image; the entrypoint
# starts it. Pinned to the digest current at authoring time — re-pin
# deliberately when refreshing the image.
COPY --from=ghcr.io/blaxel-ai/sandbox@sha256:8ebb596be14ed4c48f6fe4352e9d3de45dc31634dbca2194293187f54aba8647 \
  /sandbox-api /usr/local/bin/sandbox-api

# The published stack: `cadet`/`gateway`/`assistant` bins on PATH plus every
# runtime package (@mycadet/cli, web, gateway, assistant, credential-executor).
ARG MYCADET_VERSION=0.13.0
RUN bun add -g "mycadet@${MYCADET_VERSION}"

# Runtime sources the CLI's daemon/gateway/CES resolvers can find. A plain bun
# install of the meta-package hoists @mycadet/{assistant,gateway,credential-executor}
# into node_modules; the <service> symlinks make /app read as a source tree so
# the find<X>SourceFromCwd() resolvers in cli/src/lib/local.ts pick them up
# without a lockfile-recorded runtimeInstallDir.
WORKDIR /app
RUN printf '{"private":true,"dependencies":{"mycadet":"%s"}}\n' "${MYCADET_VERSION}" > package.json \
  && bun install --ignore-scripts \
  && ln -s node_modules/@mycadet/assistant assistant \
  && ln -s node_modules/@mycadet/gateway gateway \
  && ln -s node_modules/@mycadet/credential-executor credential-executor

# Hatch the golden assistant: lockfile entry, workspace, signing identity and
# first-boot migrations bake into the image. Every sandbox from this image
# starts from this state; API keys and other secrets inject at create time.
# The build runs headless, so the provider/API-key prompts are skipped and
# hatch only warns that no key is configured yet.
RUN cd /app && cadet hatch --name cadet --remote local

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /app
ENTRYPOINT ["/entrypoint.sh"]
