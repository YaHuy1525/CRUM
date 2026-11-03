import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import type { DocumentJobData, DocumentJobResult } from './document-queue.js';
import { runIntake } from './intake-run.js';

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export async function processDocumentJob(
  job: Job<DocumentJobData, DocumentJobResult>
): Promise<DocumentJobResult> {
  const { tenantId, userId, fileName, fileData, mimeType, source } = job.data;

  await job.updateProgress(10);

  const result = await runIntake({
    tenantId,
    ownerId: userId,
    title: fileName,
    mime: mimeType,
    source: source === 'api' ? 'upload' : source,
    sourceRef: null,
    dataBase64: fileData,
  });

  await job.updateProgress(100);

  return {
    documentId: result.documentId,
    status: 'completed',
    kind: result.kind,
    confidence: result.confidence ?? undefined,
    chunkCount: result.chunkCount,
  };
}

export const documentWorker = new Worker<DocumentJobData, DocumentJobResult>(
  'document-processing',
  async (job) => {
    console.log(`[DocumentWorker] Processing job ${job.id} for file ${job.data.fileName}`);
    await job.updateProgress(5);
    const result = await processDocumentJob(job);
    console.log(`[DocumentWorker] Job ${job.id} completed: ${result.documentId}`);
    return result;
  },
  {
    connection,
    concurrency: 5,
    limiter: {
      max: 10,
      duration: 60000,
    },
  }
);

documentWorker.on('failed', (job, err) => {
  console.error(`[DocumentWorker] Job ${job?.id} failed: ${err.message}`);
});

documentWorker.on('error', (err) => {
  console.error(`[DocumentWorker] Worker error: ${err.message}`);
});

export function startDocumentWorker() {
  console.log('[DocumentWorker] Starting document processing worker...');
  return documentWorker;
}

export async function stopDocumentWorker() {
  console.log('[DocumentWorker] Stopping document processing worker...');
  await documentWorker.close();
}
