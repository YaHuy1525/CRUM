import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export interface DocumentJobData {
  tenantId: string;
  userId: string;
  fileId: string;
  fileName: string;
  fileData: string;
  mimeType: string;
  source: 'upload' | 'email' | 'api';
}

export interface DocumentJobResult {
  documentId: string;
  status: 'completed' | 'failed';
  kind?: string;
  confidence?: number;
  chunkCount?: number;
  error?: string;
}

export const documentQueue = new Queue<DocumentJobData, DocumentJobResult>(
  'document-processing',
  { connection }
);

export const documentQueueEvents = new QueueEvents('document-processing', { connection });

export async function queueDocumentProcessing(data: DocumentJobData): Promise<string> {
  const job = await documentQueue.add('process-document', data, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: {
      age: 24 * 3600,
      count: 1000,
    },
    removeOnFail: {
      age: 7 * 24 * 3600,
    },
  });

  return job.id!;
}

export async function getJobStatus(jobId: string) {
  const job = await documentQueue.getJob(jobId);
  if (!job) {
    return null;
  }

  const state = await job.getState();
  const progress = job.progress;

  return {
    id: job.id,
    state,
    progress,
    data: job.data,
    result: job.returnvalue,
    failedReason: job.failedReason,
    timestamp: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
  };
}
