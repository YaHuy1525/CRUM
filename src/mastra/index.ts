import { Mastra } from '@mastra/core/mastra'
import { PostgresStoreVNext } from '@mastra/pg'

// CRUM agents will be registered here
const crumAgents = {}

// CRUM workflows will be registered here
const crumWorkflows = {}

export const crumMastra = new Mastra({
  agents: crumAgents,
  workflows: crumWorkflows,
  storage: new PostgresStoreVNext({
    connectionString: process.env.DATABASE_URL || '',
  }),
})
