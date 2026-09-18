FROM node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34 AS extraction
WORKDIR /app/workers/intake/extraction
COPY workers/intake/extraction/package.json workers/intake/extraction/package-lock.json ./
COPY workers/intake/extraction/vendor ./vendor
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY workers/intake/extraction/entry.mjs workers/intake/extraction/adapter.mjs workers/intake/extraction/profile.mjs ./
COPY src/contracts/intake.ts src/contracts/intake_extraction.ts /app/src/contracts/
USER 1000:1000
WORKDIR /work
ENTRYPOINT ["node","--experimental-strip-types","--permission","--allow-fs-read=/app/workers/intake/extraction","--allow-fs-read=/app/src/contracts","--allow-fs-read=/input/original","--max-old-space-size=128","/app/workers/intake/extraction/entry.mjs"]

FROM node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34 AS extraction_private
WORKDIR /work
COPY ci/intake/extraction/ ./ci/intake/extraction/
COPY ci/intake/reception/private_phase.mjs ./ci/intake/reception/private_phase.mjs
COPY src/contracts/intake.ts src/contracts/intake_extraction.ts ./src/contracts/
USER 1000:1000
ENTRYPOINT ["node","--experimental-strip-types","--max-old-space-size=256","/work/ci/intake/extraction/server.mjs"]

# Trusted verification package, never an analyzer or serving participant.
# It receives source only; no daemon socket, credentials or live data mounts.
FROM node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34 AS verification
WORKDIR /work
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN mkdir -p /work/test-results && chown node:node /work /work/test-results
USER node
CMD ["node","ci/intake/extraction/verify_package.mjs"]
