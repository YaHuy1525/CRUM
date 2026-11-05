import { startDocumentWorker, stopDocumentWorker } from './document-worker'
import { startBatchWorker, stopBatchWorker } from './batch-worker'

/**
 * Standalone queue consumer. The REST plane can start these in-process (see
 * src/api/serve.ts), but a containerised stack runs the planes from the Mastra
 * bundle, which never calls serve.ts, so the jobs would queue forever.
 *
 * Start it with `npm run queue:worker`: that script carries
 * `--env-file-if-exists=.env`, which is how REDIS_URL reaches these modules.
 */
function main(): void {
  console.log(`[QueueWorker] REDIS_URL=${process.env.REDIS_URL ?? 'redis://localhost:6379'}`)
  startDocumentWorker()
  startBatchWorker()

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void Promise.allSettled([stopDocumentWorker(), stopBatchWorker()]).then(() => {
        process.exit(0)
      })
    })
  }
}

main()
