// tests/evals/load-env.ts
//
// Side-effect module: loads the project .env into process.env AT IMPORT TIME.
// It must be the FIRST import of any test file that transitively loads
// src/mastra/agent.ts, because that module bakes its model ids from
// process.env when it is first evaluated (fromProcess() in src/mastra/models.ts).
// Loading .env later — in the test file's module body or beforeAll — is too
// late: the static imports are hoisted and already pinned the agent to the
// `:free` defaults, which die on OpenRouter's free-models-per-day cap. The dev
// server never sees this because `npm run dev` loads .env before booting.
//
// Vitest inline projects load no .env at all (no dotenv dependency in this
// repo), so the load is explicit here. An absent file is not an error —
// suites that need a key guard on it themselves and report a skip.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const envPath = fileURLToPath(new URL('../../.env', import.meta.url))
if (existsSync(envPath)) {
  process.loadEnvFile(envPath)
}
