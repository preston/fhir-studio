# Build from the monorepo root:
#   docker build -f ui/Dockerfile -t fhir-studio-ui:latest .

FROM node:26-alpine AS builder
LABEL maintainer="Preston Lee"

WORKDIR /app

COPY package.json package-lock.json ./
COPY core/package.json core/tsconfig.json ./core/
COPY core/src ./core/src
COPY ui/package.json ui/tsconfig.json ui/tsconfig.app.json ui/angular.json ./ui/
COPY server/package.json ./server/

# Workspace install pulls server (package.json only); skip its postinstall
# prisma generate (schema and database URL are not in this image).
RUN npm ci --ignore-scripts

COPY ui ./ui

RUN npm run build --workspace=@fhir-studio/core \
  && npm run build --workspace=@fhir-studio/ui

FROM nginx:stable-alpine
LABEL maintainer="Preston Lee"

# envsubst for configuration.template.js
RUN apk add --no-cache gettext

COPY ui/nginx.conf /etc/nginx/conf.d/default.conf

WORKDIR /usr/share/nginx/html
RUN rm -rf *

COPY --from=builder /app/ui/dist/ui/browser .
COPY ui/public/configuration.template.js .
COPY ui/entrypoint.sh .
RUN chmod +x entrypoint.sh

EXPOSE 80

CMD ["./entrypoint.sh"]
