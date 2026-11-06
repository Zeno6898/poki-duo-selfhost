# Poki MCP on Linux, for a server that controls a phone over the tailnet.
# Build from the repository root:  docker build -f deploy/Dockerfile -t poki-mcp .
# Fork-only packaging; see deploy/README.md.

# --- native tools: idevice-tools at the pinned revision and the poki-native bridge ------------
FROM rust:1-bookworm AS native
ARG IDEVICE_REVISION=89702099f4d7552f704f93b4526756abda319ceb
WORKDIR /src
RUN git clone https://github.com/jkcoxson/idevice.git .deps/idevice \
 && git -C .deps/idevice checkout --detach "$IDEVICE_REVISION"
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cd .deps/idevice && cargo build --locked --release -p idevice-tools --bin idevice-tools --bin idevice_id
COPY native/bridge native/bridge
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --locked --release --manifest-path native/bridge/Cargo.toml --target-dir build/native-target --bin poki-native --bin poki-pair-remote

# --- JavaScript dependencies ---------------------------------------------------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime -------------------------------------------------------------------------------
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates libssl3 tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json package-lock.json LICENSE THIRD_PARTY_NOTICES.md ./
COPY src src
COPY bin bin
COPY native/devices.py native/
COPY skills skills
COPY --from=native /src/.deps/idevice/target/release/idevice-tools /src/.deps/idevice/target/release/idevice_id .deps/idevice/target/release/
COPY --from=native /src/build/native-target/release/poki-native /src/build/native-target/release/poki-pair-remote build/
# The daemon runs as the unprivileged node user; state (token, OAuth keys, account) lives in /state.
ENV POKI_MCP_STATE_DIR=/state \
    IDEVICE_TOOLS=/app/.deps/idevice/target/release/idevice-tools \
    NODE_ENV=production
RUN mkdir -p /state && chown node:node /state
USER node
VOLUME ["/state"]
EXPOSE 47825
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/daemon.mjs"]
