# Build from the monorepo root:
#   docker build -f server/Dockerfile -t fhir-studio-server:latest .

FROM node:26-trixie-slim AS builder
LABEL maintainer="Preston Lee"

WORKDIR /app

# Prisma needs OpenSSL to pick the correct engine (Debian = OpenSSL 3.x). Slim images omit it.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY core/package.json core/tsconfig.json ./core/
COPY core/src ./core/src
COPY server/package.json server/tsconfig.json server/prisma.config.ts ./server/
COPY server/prisma ./server/prisma
COPY server/src ./server/src
# Root workspaces list ui; package.json stub satisfies npm without UI sources.
COPY ui/package.json ./ui/

# prisma generate (postinstall + build) reads prisma.config.ts, which requires this
# variable. Generate does not connect; keep the placeholder off the runtime image ENV.
ENV FHIR_STUDIO_SERVER_DATABASE_URL=postgresql://build:build@127.0.0.1:5432/fhir_studio_build

# Install only server + core (skip @fhir-studio/ui / Angular).
RUN npm ci --workspace=@fhir-studio/server --workspace=@fhir-studio/core --include-workspace-root

RUN npm run build --workspace=@fhir-studio/core \
  && npm run build --workspace=@fhir-studio/server

# Drop TypeScript and other build-only packages before copying into the runtime image.
# --ignore-scripts avoids re-running core's prepare (tsc) after typescript is removed.
RUN npm prune --omit=dev --ignore-scripts --workspace=@fhir-studio/server --workspace=@fhir-studio/core --include-workspace-root

FROM node:26-trixie-slim AS runner
LABEL maintainer="Preston Lee"

WORKDIR /app

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/core/package.json ./core/
COPY --from=builder /app/core/build ./core/build
COPY --from=builder /app/server/package.json ./server/
COPY --from=builder /app/server/build ./server/build
COPY --from=builder /app/server/prisma ./server/prisma
COPY --from=builder /app/server/prisma.config.ts ./server/

WORKDIR /app/server
EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && exec node build/server.js"]
