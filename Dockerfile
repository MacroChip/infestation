# syntax=docker/dockerfile:1

# LEADFIELD is a Vite-built browser client served by a Node "ws" game server.
# Two stages: "build" compiles the client into client/dist; "runtime" ships the
# built client plus the server, run straight from TypeScript with tsx (the
# server imports shared/*.ts by extensionless path, which only tsx resolves).

# ---- build stage: install everything and build the client -------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install deps first (cached until package*.json change). npm ci needs the
# lockfile and installs devDependencies too (vite, tsx, typescript).
COPY package.json package-lock.json ./
RUN npm ci

# Bring in the source and produce the production client bundle.
COPY . .
RUN npm run build

# ---- runtime stage: the server + built client only --------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# node_modules carries tsx (used to run the server) and ws; client/dist is the
# built browser bundle the server statically hosts.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared

# Default game/http port (overridable via PORT). One port serves both the
# client and the WebSocket.
ENV PORT=8081
EXPOSE 8081

# Run unprivileged; the base image ships a "node" user.
USER node

# npm run start -> tsx server/src/index.ts
CMD ["npm", "run", "start"]
