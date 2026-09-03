FROM node:24-alpine AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN npm ci

FROM dependencies AS source
COPY . .

FROM source AS api-build
RUN npm run build -w @cpi/api

FROM source AS bot-build
RUN npm run build -w @cpi/bot

FROM source AS worker-build
RUN npm run build -w @cpi/worker

FROM source AS web-build
ARG NEXT_PUBLIC_DEV_AUTH_ENABLED=false
ENV NEXT_PUBLIC_DEV_AUTH_ENABLED=$NEXT_PUBLIC_DEV_AUTH_ENABLED
RUN npm run build -w @cpi/web

FROM node:24-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=api-build /app/apps/api/dist ./apps/api/dist
COPY package.json ./
USER node
EXPOSE 3001
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]

FROM node:24-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=worker-build /app/apps/worker/dist ./apps/worker/dist
COPY package.json ./
USER node
EXPOSE 3003
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/worker/dist/index.js"]

FROM node:24-alpine AS bot
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini
# MAX currently serves a chain anchored at the Ministry of Digital Development's Russian
# Trusted Root CA. Node 24.20's bundled roots and Alpine's current ca-certificates package no
# longer contain that anchor, so append only the official Gosuslugi certificate for this bot
# image. Keep the fingerprint check beside the copy so an accidental asset replacement fails the
# image build instead of silently widening trust.
# Source: https://gu-st.ru/content/Other/doc/russian_trusted_root_ca.cer
COPY --chown=node:node infra/certs/russian-trusted-root-ca.pem /app/certs/russian-trusted-root-ca.pem
RUN node -e "const fs=require('node:fs');const {X509Certificate}=require('node:crypto');const cert=new X509Certificate(fs.readFileSync('/app/certs/russian-trusted-root-ca.pem'));const expected='D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31';if(!cert.ca||cert.issuer!==cert.subject||!cert.verify(cert.publicKey)||cert.fingerprint256!==expected)throw new Error('MAX API CA certificate verification failed')"
ENV NODE_EXTRA_CA_CERTS=/app/certs/russian-trusted-root-ca.pem
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=bot-build /app/apps/bot/dist ./apps/bot/dist
COPY package.json ./
USER node
EXPOSE 3002
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/bot/dist/index.js"]

FROM node:24-alpine AS tools
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=dependencies /app/node_modules ./node_modules
COPY packages/db ./packages/db
COPY packages/shared ./packages/shared
COPY package.json tsconfig.base.json ./
ENTRYPOINT ["/sbin/tini", "--"]

FROM node:24-alpine AS web
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
RUN apk add --no-cache tini
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
