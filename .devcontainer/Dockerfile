# syntax=docker/dockerfile:1
FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_VERSION=24.21.0
ARG TARGETARCH
ARG PLAYWRIGHT_VERSION=1.62.0-alpha-2026-07-20

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash build-essential ca-certificates clang cmake curl gnupg jq libssl-dev \
    lsof pkg-config postgresql-client python3 software-properties-common sudo \
    unzip xz-utils \
    && add-apt-repository -y ppa:git-core/ppa \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/github-cli.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/github-cli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    git gh docker-ce-cli docker-buildx-plugin docker-compose-plugin \
    && dpkg --compare-versions "$(git version | cut -d' ' -f3)" ge 2.46 \
    && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) exit 1 ;; esac \
    && mkdir -p /opt/node-download \
    && cd /opt/node-download \
    && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
    && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    && grep " node-v${NODE_VERSION}-linux-${arch}.tar.xz$" SHASUMS256.txt | sha256sum -c - \
    && tar -xJf "node-v${NODE_VERSION}-linux-${arch}.tar.xz" --strip-components=1 -C /usr/local \
    && rm -rf /opt/node-download \
    && if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu; fi \
    && groupadd --gid 1000 vscode && useradd --uid 1000 --gid vscode --create-home --shell /bin/bash vscode

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    PILOTSWARM_DEVCONTAINER=1 \
    GH_CONFIG_DIR=/home/vscode/.config/gh \
    NX_DAEMON=false

# Only the matching browser installer is downloaded; application source and
# credentials never enter the image build context.
RUN mkdir -p /opt/playwright-installer \
    && cd /opt/playwright-installer \
    && npm install --ignore-scripts --no-audit --no-fund "playwright@${PLAYWRIGHT_VERSION}" \
    && node node_modules/playwright/cli.js install --with-deps chromium firefox webkit \
    && chmod -R a+rX /opt/playwright \
    && rm -rf /opt/playwright-installer /root/.npm /var/lib/apt/lists/*

COPY scripts/entrypoint.sh /usr/local/bin/pilotswarm-dev-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/pilotswarm-dev-entrypoint \
    && chmod 0755 /usr/local/bin/pilotswarm-dev-entrypoint
WORKDIR /workspaces/PilotSwarm
ENTRYPOINT ["/usr/local/bin/pilotswarm-dev-entrypoint"]
CMD ["sleep", "infinity"]
