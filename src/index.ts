import { parseEnv } from './config/env'
import { createCrumMastra } from './mastra'

// Phase 1: construct the singleton at process startup, where the process
// environment is the right thing to read. No module-level singleton on purpose
// (see src/mastra/index.ts comment).
const env = parseEnv()
const mastra = createCrumMastra(env)

// Mastra CLI reads this export and starts the server.
export default mastra
