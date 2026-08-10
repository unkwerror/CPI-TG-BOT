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
COPY packages/spreadsheet/package.json packages/spreadsheet/package.json
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
