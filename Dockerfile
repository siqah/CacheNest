# syntax=docker/dockerfile:1

FROM node:22-alpine AS dependencies

WORKDIR /app

# better-sqlite3 is a native module. These build tools stay in the dependency
# stage and are not copied into the final runtime image.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    CACHE_DIR=/app/data \
    MAX_CACHE_GB=10

WORKDIR /app

# Run as the unprivileged node user that ships with the official image.
RUN mkdir -p /app/data && chown -R node:node /app

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node

EXPOSE 8787

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health',{headers:process.env.API_KEY?{authorization:'Bearer '+process.env.API_KEY}:{}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

STOPSIGNAL SIGTERM

CMD ["node", "src/index.js"]
