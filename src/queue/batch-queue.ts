import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { DocumentJobData } from './document-queue.js';

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export interface BatchJob {
  batchId: string;
  tenantId: string;
  userId: string;
  files: Array<{
    fileId: string;
    fileName: string;
    status: 'queued' | 'processing' | 'completed' | 'failed';
    jobId?: string;
    documentId?: string;
    error?: string;
  }>;
  createdAt: Date;
  completedAt?: Date;
  totalFiles: number;
  processedFiles: number;
  failedFiles: number;
}

const batchJobs = new Map<string, BatchJob>();

export const batchQueue = new Queue<DocumentJobData & { batchId: string }>(
  'batch-document-processing',
  { connection }
);

export async function createBatchJob(
  tenantId: string,
  userId: string,
  files: Array<{ fileName: string; fileData: string; mimeType: string }>
): Promise<BatchJob> {
  const batchId = `batch_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  const batchJob: BatchJob = {
    batchId,
    tenantId,
    userId,
    files: files.map((f, i) => ({
      fileId: `${batchId}_${i}`,
      fileName: f.fileName,
      status: 'queued',
    })),
    createdAt: new Date(),
    totalFiles: files.length,
    processedFiles: 0,
    failedFiles: 0,
  };

  batchJobs.set(batchId, batchJob);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const tracked = batchJob.files[i];
    if (!file || !tracked) continue;

    const fileId = tracked.fileId;

    const job = await batchQueue.add(
      'process-batch-document',
      {
        tenantId,
        userId,
        fileId,
        fileName: file.fileName,
        fileData: file.fileData,
        mimeType: file.mimeType,
        source: 'upload',
        batchId,
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      }
    );

    tracked.jobId = job.id ?? undefined;
  }

  return batchJob;
}

export function getBatchJob(batchId: string): BatchJob | null {
  return batchJobs.get(batchId) ?? null;
}

export function updateBatchJobStatus(
  batchId: string,
  fileId: string,
  status: 'processing' | 'completed' | 'failed',
  result?: { documentId?: string; error?: string }
): void {
  const batch = batchJobs.get(batchId);
  if (!batch) return;

  const file = batch.files.find(f => f.fileId === fileId);
  if (!file) return;

  file.status = status;
  if (result?.documentId) file.documentId = result.documentId;
  if (result?.error) file.error = result.error;

  if (status === 'completed') {
    batch.processedFiles++;
  } else if (status === 'failed') {
    batch.failedFiles++;
  }

  if (batch.processedFiles + batch.failedFiles === batch.totalFiles) {
    batch.completedAt = new Date();
  }
}

export function listBatchJobs(tenantId: string): BatchJob[] {
  return Array.from(batchJobs.values()).filter(b => b.tenantId === tenantId);
}

export interface BatchProgress {
  total: number;
  processed: number;
  failed: number;
  pending: number;
  percentComplete: number;
}

export function getBatchProgress(batchId: string): BatchProgress | null {
  const batch = batchJobs.get(batchId);
  if (!batch) return null;

  const pending = batch.totalFiles - batch.processedFiles - batch.failedFiles;
  const percentComplete = ((batch.processedFiles + batch.failedFiles) / batch.totalFiles) * 100;

  return {
    total: batch.totalFiles,
    processed: batch.processedFiles,
    failed: batch.failedFiles,
    pending,
    percentComplete: Math.round(percentComplete * 100) / 100,
  };
}
