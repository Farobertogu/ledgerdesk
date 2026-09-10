FROM node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34 AS node_runtime
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
USER root
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends libnss3-tools openssl postgresql-16 && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src/contracts/access*.ts ./src/contracts/
COPY src/contracts/material_reading.ts src/contracts/reading_origin.ts ./src/contracts/
COPY src/server/access ./src/server/access
COPY src/server/reading ./src/server/reading
COPY src/server/kb/reading.ts ./src/server/kb/reading.ts
COPY src/components/access ./src/components/access
COPY src/components/reading ./src/components/reading
COPY ci/access_material_schema.mjs ./ci/access_material_schema.mjs
COPY ci/access_final_routes.mjs ./ci/access_final_routes.mjs
COPY src/app/access ./src/app/access
COPY src/app/layout.tsx src/app/globals.css ./src/app/
COPY src/instrumentation.ts ./src/instrumentation.ts
COPY next.config.mjs postcss.config.mjs tsconfig.app.json ./
COPY tests/access ./tests/access
COPY tests/reading/timing_comparison.mjs ./tests/reading/timing_comparison.mjs
COPY tests/reading/browser_diagnostics.mjs ./tests/reading/browser_diagnostics.mjs
COPY tests/reading/T04_seed.mjs ./tests/reading/T04_seed.mjs
ENV NEXT_TELEMETRY_DISABLED=1 LEDGERDESK_ACCESS_CONTAINER=1
ARG ACCESS_UI_MUTATION=""
ARG ACCESS_FINAL_ROUTES="0"
# The read-only BuildKit input is a public source inventory, not a credential.
# Its independent digest binds the copied files and invalidates the build cache.
ARG ACCESS_COMPOSITION_SHA256=""
ENV ACCESS_COMPOSITION_SHA256=$ACCESS_COMPOSITION_SHA256
RUN --mount=type=secret,id=access_composition if [ "$ACCESS_FINAL_ROUTES" = "1" ]; then node ci/access_final_routes.mjs && node node_modules/next/dist/bin/next build tests/access/final-ui --webpack; else ACCESS_UI_MUTATION="$ACCESS_UI_MUTATION" node tests/access/ui_mutation.mjs && node node_modules/next/dist/bin/next build tests/access/runtime-ui --webpack; fi && mkdir /work/output && chown -R pwuser:pwuser /work/tests/access /work/output
USER pwuser
CMD ["node", "--experimental-strip-types", "--test", "--test-concurrency=1", "tests/access/test_runtime.mjs"]
