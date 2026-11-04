ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.20
FROM ${BUILD_FROM}

# Set shell with pipefail
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Install Node.js LTS, git, curl, and CA certificates
RUN apk add --no-cache \
    nodejs \
    npm \
    curl \
    ca-certificates \
    tzdata

WORKDIR /opt/whatsapp_addon

# Copy reproducible dependency manifests first for Docker layer caching
COPY package.json package-lock.json ./

# Install production dependencies reproducibly
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Copy application source and frontend assets
COPY src ./src
COPY frontend ./frontend
COPY run.sh /run.sh
COPY rootfs /

RUN chmod a+x /run.sh \
    && chmod a+x /etc/services.d/whatsapp/run \
    && chmod a+x /etc/services.d/whatsapp/finish

ENV NODE_ENV=production \
    PORT=8099 \
    DATA_DIR=/data

EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8099/api/health || exit 1

CMD [ "/run.sh" ]
