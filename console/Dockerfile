# syntax=docker/dockerfile:1

# CRUM console image (Next.js).
#
# The browser only ever talks to this origin (:3000). next.config.js declares two
# server-side rewrites — /chat/* to the Mastra server and /api/* to the REST
# plane — and Next evaluates those rewrite destinations at BUILD time, baking the
# upstream origins into the route table. So the origins must be present during
# `next build`, not only at runtime; that is why they arrive as build ARGs with
# the Compose service names as the default.

ARG NODE_VERSION=22

# ---- deps: install console node_modules ----
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: install-time lifecycle scripts are the supply-chain attack
# path (Sonar security hotspot). The console tree needs none: Next ships its
# compiler as plain optionalDependencies binaries, with no postinstall build.
RUN npm ci --no-audit --no-fund --ignore-scripts

# ---- build: compile the Next app ----
FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
ARG CRUM_MASTRA_ORIGIN=http://api:4111
ARG CRUM_REST_ORIGIN=http://api:4113
ARG NEXT_PUBLIC_SUPABASE_URL=
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=
# The console middleware runs in the Next.js Edge runtime, where a self-hosted
# `next start` exposes only build-inlined NEXT_PUBLIC_* to the sandbox. The dev
# identity must therefore be baked in as NEXT_PUBLIC_* at build time, or every
# /api and /chat call is refused with 503 identity-not-configured. These are
# non-secret local dev fixtures; override them via Compose build args and rebuild.
ARG NEXT_PUBLIC_CRUM_AUTH_MODE=dev
ARG NEXT_PUBLIC_CRUM_DEV_TENANT_ID=00000000-0000-4000-8000-000000000001
ARG NEXT_PUBLIC_CRUM_DEV_USER_ID=00000000-0000-4000-8000-000000000002
ARG NEXT_PUBLIC_CRUM_DEV_USER_ROLE=admin
ENV CRUM_MASTRA_ORIGIN=$CRUM_MASTRA_ORIGIN
ENV CRUM_REST_ORIGIN=$CRUM_REST_ORIGIN
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_CRUM_AUTH_MODE=$NEXT_PUBLIC_CRUM_AUTH_MODE
ENV NEXT_PUBLIC_CRUM_DEV_TENANT_ID=$NEXT_PUBLIC_CRUM_DEV_TENANT_ID
ENV NEXT_PUBLIC_CRUM_DEV_USER_ID=$NEXT_PUBLIC_CRUM_DEV_USER_ID
ENV NEXT_PUBLIC_CRUM_DEV_USER_ROLE=$NEXT_PUBLIC_CRUM_DEV_USER_ROLE
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner: serve the compiled app ----
FROM node:${NODE_VERSION}-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# Re-declare the origins for runtime too. The rewrite destinations were baked at
# build, but keeping the env honest means a later config read sees the same value.
ARG CRUM_MASTRA_ORIGIN=http://api:4111
ARG CRUM_REST_ORIGIN=http://api:4113
ENV CRUM_MASTRA_ORIGIN=$CRUM_MASTRA_ORIGIN
ENV CRUM_REST_ORIGIN=$CRUM_REST_ORIGIN
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app ./
EXPOSE 3000
CMD ["npm", "start"]
