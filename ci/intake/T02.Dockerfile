FROM node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34 AS node_runtime
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 AS runtime
USER root
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends libnss3-tools openssl postgresql-16 && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src/contracts/ ./src/contracts/
COPY src/server/access/ ./src/server/access/
COPY src/server/intake/ ./src/server/intake/
COPY src/server/reading/ ./src/server/reading/
COPY src/server/kb/reading.ts ./src/server/kb/reading.ts
COPY ci/access_material_schema.mjs ./ci/access_material_schema.mjs
COPY ci/intake_boundary_check.mjs ci/access_boundary_check.mjs ci/reading_boundary_check.mjs ./ci/
COPY tests/access/ ./tests/access/
COPY tests/reading/T04_seed.mjs ./tests/reading/T04_seed.mjs
COPY tests/reading/timing_comparison.mjs ./tests/reading/timing_comparison.mjs
COPY tests/intake/t02/ ./tests/intake/t02/
COPY tests/intake/extraction/ ./tests/intake/extraction/
COPY tests/intake/preparation/ ./tests/intake/preparation/
COPY tests/intake/t01/fixtures.mjs ./tests/intake/t01/fixtures.mjs
COPY tests/intake/t01/fixtures/ ./tests/intake/t01/fixtures/
COPY tests/intake/t01/boundaries/ ./tests/intake/t01/boundaries/
RUN mkdir -p /work/output && chown pwuser:pwuser /work/output
ENV LEDGERDESK_ACCESS_CONTAINER=1 LEDGERDESK_INTAKE_CONTAINER=1
USER pwuser
CMD ["node", "--experimental-strip-types", "--test", "--test-concurrency=1", "tests/intake/t02/test_runtime.mjs"]

FROM runtime AS ui_runtime
USER root
COPY src/components/access/ ./src/components/access/
COPY src/components/reading/ ./src/components/reading/
COPY src/components/intake/ ./src/components/intake/
COPY src/app/access/ ./src/app/access/
COPY src/app/layout.tsx src/app/globals.css ./src/app/
COPY src/instrumentation.ts ./src/instrumentation.ts
COPY next.config.mjs postcss.config.mjs tsconfig.app.json ./
COPY ci/access_final_routes.mjs ./ci/access_final_routes.mjs
COPY tests/intake/ui/ ./tests/intake/ui/
COPY tests/reading/browser_diagnostics.mjs ./tests/reading/browser_diagnostics.mjs
ENV NEXT_TELEMETRY_DISABLED=1
ARG ACCESS_COMPOSITION_SHA256=""
ENV ACCESS_COMPOSITION_SHA256=$ACCESS_COMPOSITION_SHA256
RUN --mount=type=secret,id=access_composition node ci/access_final_routes.mjs && node node_modules/next/dist/bin/next build tests/access/final-ui --webpack && chown -R pwuser:pwuser /work/tests/access/final-ui
USER pwuser

FROM node_runtime AS private_service
WORKDIR /work
COPY ci/intake/reception/package.json ci/intake/reception/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY ci/intake/reception/*.mjs ./
COPY tests/intake/t02/test_private_phase.mjs ./test_private_phase.mjs
USER node
ENTRYPOINT ["node", "--max-old-space-size=128", "/work/server.mjs"]
