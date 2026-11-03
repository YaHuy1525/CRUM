import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Load .env before any module that reads process.env at import time.
const envPath = fileURLToPath(new URL('../../.env', import.meta.url))
if (existsSync(envPath)) {
  process.loadEnvFile(envPath)
}

import { parseEnv } from '../../src/config/env.js'
import { createDocumentsRouter, type DocumentQueueLike } from '../../src/api/documents.js'
import { getDbClient } from '../../src/db/client.js'
import type { Pool } from 'pg'

export interface TestServer {
  /** Make an HTTP request against the documents router. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>
  /** Direct database access for test setup and assertions. */
  db: Pool
  /** Release resources. */
  close: () => Promise<void>
}

/**
 * Create a test server that wires the documents router to the real database
 * and exposes a `fetch()` method for making requests without binding a port.
 *
 * Pass a `queue` to override the default (null = uploads return 503).
 */
export function createTestServer(queue?: DocumentQueueLike | null): Promise<TestServer> {
  const env = parseEnv({})
  const app = createDocumentsRouter({ env, queue: queue ?? null })
  const db = getDbClient()

  return Promise.resolve({
    fetch: (path: string, init?: RequestInit) => Promise.resolve(app.request(path, init)),
    db,
    close: async () => {
      // The pool is shared; tests should not close it because other test
      // files may still need it.  Nothing to tear down for an in-memory router.
    },
  })
}
