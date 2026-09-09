FROM node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34 AS node_runtime
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
USER root
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends libnss3-tools openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src/contracts/access*.ts ./src/contracts/
COPY src/server/access/transport.ts ./src/server/access/transport.ts
COPY tests/access ./tests/access
ENV NEXT_TELEMETRY_DISABLED=1
ENV LEDGERDESK_ACCESS_CONTAINER=1
RUN node node_modules/next/dist/bin/next build tests/access/ui --webpack && chown -R pwuser:pwuser /work/tests/access/ui/.next
USER pwuser
CMD ["node", "--experimental-strip-types", "--test", "--test-concurrency=1", "tests/access/test_security.mjs", "tests/access/test_transport_browser.mjs"]
