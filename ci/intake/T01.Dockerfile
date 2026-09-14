FROM node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34 AS control
WORKDIR /work
COPY tests/intake/t01/package.json tests/intake/t01/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tests/intake/t01/reviewed/package.json tests/intake/t01/reviewed/package-lock.json ./reviewed/
COPY tests/intake/t01/reviewed/vendor ./reviewed/vendor
RUN cd reviewed && npm ci --ignore-scripts --no-audit --no-fund
COPY tests/intake/t01/ ./tests/
COPY tests/intake/t01/reviewed/*.mjs ./reviewed/
COPY tests/intake/t01/reviewed/package.json ./reviewed/
COPY src/contracts/intake*.ts ./src/contracts/
USER 1000:1000
CMD ["node", "-e", "setInterval(()=>{},1000)"]

FROM node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34 AS parser
WORKDIR /work
COPY --from=control /work/reviewed/node_modules ./reviewed/node_modules
COPY tests/intake/t01/reviewed/package.json tests/intake/t01/reviewed/adapter.mjs tests/intake/t01/reviewed/producer.mjs tests/intake/t01/reviewed/profile.mjs ./reviewed/
COPY tests/intake/t01/probe.mjs ./probe.mjs
COPY tests/intake/t01/l03_gate.mjs ./l03_gate.mjs
USER 1000:1000
