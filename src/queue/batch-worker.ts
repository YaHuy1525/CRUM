import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import type { DocumentJobData, DocumentJobResult } from './document-queue.js';
import { batchQueue, updateBatchJobStatus } from './batch-queue.js';
import { runIntake } from './intake-run.js';

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export type BatchJobData = DocumentJobData & { batchId: string };

export async function processBatchJob(
  job: Job<BatchJobData, DocumentJobResult>
): Promise<DocumentJobResult> {
  const { tenantId, userId, fileId, fileName, fileData, mimeType, source, batchId } = job.data;

  updateBatchJobStatus(batchId, fileId, 'processing');
  await job.updateProgress(10);

  try {
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
    updateBatchJobStatus(batchId, fileId, 'completed', { documentId: result.documentId });

    return {
      documentId: result.documentId,
      status: 'completed',
      kind: result.kind,
      confidence: result.confidence ?? undefined,
      chunkCount: result.chunkCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateBatchJobStatus(batchId, fileId, 'failed', { error: message });
    throw error;
  }
}

export const batchWorker = new Worker<BatchJobData, DocumentJobResult>(
  'batch-document-processing',
  async (job) => {
    console.log(`[BatchWorker] Job ${job.id} started for ${job.data.fileName}`);
    return processBatchJob(job);
  },
  { connection, concurrency: 3 }
);

batchWorker.on('failed', (job, err) => {
  console.error(`[BatchWorker] Job ${job?.id} failed: ${err.message}`);
});

batchWorker.on('error', (err) => {
  console.error(`[BatchWorker] Worker error: ${err.message}`);
});

export function startBatchWorker(): Worker<BatchJobData, DocumentJobResult> {
  console.log('[BatchWorker] Starting batch document worker...');
  return batchWorker;
}

export async function stopBatchWorker(): Promise<void> {
  await batchWorker.close();
  await batchQueue.close();
  await connection.quit();
}
