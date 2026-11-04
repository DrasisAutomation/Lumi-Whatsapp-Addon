ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.20
FROM ${BUILD_FROM}

# Set shell with pipefail
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Install Node.js LTS, git, curl, and CA certificates
RUN apk add --no-cache \
    nodejs \
    npm \
    git \
    openssh-client \
    curl \
    ca-certificates \
    tzdata

# Ensure any git+ssh dependencies (such as libsignal-node) resolve over HTTPS without SSH keys
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && git config --global url."https://github.com/".insteadOf "git@github.com:"

WORKDIR /opt/whatsapp_addon

# Copy reproducible dependency manifests first for Docker layer caching
COPY package.json package-lock.json ./

# Install production dependencies reproducibly
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Copy application source and frontend assets
COPY src ./src
COPY frontend ./frontend
COPY run.sh /run.sh

RUN chmod a+x /run.sh

ENV NODE_ENV=production \
    PORT=8653 \
    DATA_DIR=/data

EXPOSE 8653

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8653/api/health || exit 1

CMD [ "/run.sh" ]
