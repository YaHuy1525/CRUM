# syntax=docker/dockerfile:1

# CRUM api plane image.
#
# It runs the two server halves from one process, exactly as `npm start` does on
# a host: the Mastra HTTP server (chat + Studio on CRUM_API_PORT) and, boot-
# started in the same process, the hand-rolled Hono REST plane (CRUM_REST_PORT).
# Keeping them together is deliberate — an AgentController session lives in the
# process that owns the live run, so a REST plane in another container could list
# threads from storage but never steer the chat this process streams. See
# src/api/serve.ts and src/mastra/boot.ts.
#
# The same image doubles as the migration job (docker-compose `migrate` overrides
# the command with `npm run db:migrate`), which is why src/, migrations/ and
# scripts/ stay in the runner rather than only shipping the bundle.

ARG NODE_VERSION=22

# ---- deps: resolve node_modules for the Linux runtime platform ----
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
# esbuild and a couple of transitive deps can invoke a native build at install
# time; slim Debian has no compiler, so provide the minimal toolchain here.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- build: bundle the Mastra server (mastra build -> .mastra/output) ----
FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
# `mastra build` finishes the bundle by installing the output dir's dependencies
# with the repo's package manager. It probes for pnpm and shells out to it, so
# pnpm must exist even though the source install below uses npm (the
# authoritative lockfile is package-lock.json). Without it the stage dies with
# `pnpm: not found` / exit 127 during the bundle stage.
RUN corepack enable && corepack prepare pnpm@9 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner: minimal runtime for the api plane + migration job ----
FROM node:${NODE_VERSION}-slim AS runner
WORKDIR /app
ENV NODE_ENV=development

# The compiled server bundle that `mastra start` executes.
COPY --from=build /app/.mastra ./.mastra
# Migrations and tooling run from source through tsx, so ship their inputs.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/src ./src
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/policy ./policy

EXPOSE 4111 4113

# Run the compiled server bundle directly rather than through `mastra start`.
# `mastra start` hard-forces NODE_ENV=production when it spawns the bundle
# (mastra/dist/index.js:5044), which makes CRUM_AUTH_MODE=dev illegal at boot
# (§13.2). The local Compose stack is a development profile, so it execs the same
# bundle itself and lets the Compose environment decide NODE_ENV. For a real
# production (jwt) deploy, `mastra start` / `npm start` is the right command.
# cd into the output dir mirrors what `mastra start` does for public-file paths.
CMD ["sh", "-c", "cd .mastra/output && exec node index.mjs"]
