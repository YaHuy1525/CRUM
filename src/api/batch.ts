import { Hono } from 'hono';
import type { Context } from 'hono';
import type { CrumEnv } from '../config/env';
import type { TenantRequestContext } from '../mastra/tenant-context';
import { IdentityError, resolveIdentity } from '../mastra/identity';
import type { BatchJob, BatchProgress } from '../queue/batch-queue';
import { MAX_DOCUMENT_BYTES } from '../mastra/workflows/document-intake';

export interface BatchQueueLike {
  create(
    tenantId: string,
    userId: string,
    files: Array<{ fileName: string; fileData: string; mimeType: string }>
  ): Promise<BatchJob>;
  get(batchId: string): BatchJob | null;
  list(tenantId: string): BatchJob[];
  progress(batchId: string): BatchProgress | null;
}

const ACCEPTED_EXT = new Set([
  'pdf', 'docx', 'txt', 'md', 'markdown', 'html', 'htm',
  'csv', 'json', 'xlsx', 'xls', 'pptx',
]);

function extensionOf(name: string): string {
  return (name.toLowerCase().split('.').pop() ?? '').trim();
}

export interface BatchRouterDeps {
  env: CrumEnv;
  /**
   * Same contract as the documents router: `undefined` loads the BullMQ-backed
   * batch queue on the first request that needs it, `null` refuses with 503.
   */
  queue?: BatchQueueLike | null;
}

let defaultQueue: Promise<BatchQueueLike> | null = null

function loadDefaultQueue(): Promise<BatchQueueLike> {
  if (defaultQueue === null) {
    defaultQueue = import('../queue/batch-queue').then((mod) => ({
      create: mod.createBatchJob,
      get: mod.getBatchJob,
      list: mod.listBatchJobs,
      progress: mod.getBatchProgress,
    }))
  }
  return defaultQueue
}

export function createBatchRouter(deps: BatchRouterDeps): Hono {
  const { env, queue } = deps;
  const app = new Hono().basePath('/api/batch');

  async function resolveQueue(): Promise<BatchQueueLike | null> {
    if (queue !== undefined) return queue;
    return loadDefaultQueue();
  }

  const auth = async (
    c: Context,
  ): Promise<{ identity: TenantRequestContext } | { error: Response }> => {
    try {
      return { identity: await resolveIdentity((name) => c.req.header(name), env) };
    } catch (err) {
      if (err instanceof IdentityError) {
        return { error: c.json({ error: 'unauthorized', reason: err.reason }, 401) };
      }
      throw err;
    }
  };

  app.post('/upload', async (c) => {
    const gate = await auth(c);
    if ('error' in gate) return gate.error;
    const { tenantId, userId } = gate.identity;

    const contentType = c.req.header('content-type');
    if (!contentType?.includes('multipart/form-data')) {
      return c.json(
        { error: 'multipart_required', detail: 'Upload files as multipart/form-data.' },
        415,
      );
    }

    const form = await c.req.parseBody({ all: true });
    const files = form.files;
    
    if (!files || !Array.isArray(files) || files.length === 0) {
      return c.json({ error: 'no_files', detail: 'Upload at least one file.' }, 400);
    }

    if (files.length > 50) {
      return c.json(
        { error: 'too_many_files', detail: 'Maximum 50 files per batch.' },
        400,
      );
    }

    const fileDataList: Array<{ fileName: string; fileData: string; mimeType: string }> = [];

    for (const file of files) {
      if (!(file instanceof File)) continue;

      const ext = extensionOf(file.name);
      if (!ACCEPTED_EXT.has(ext)) {
        return c.json(
          {
            error: 'unsupported_file_type',
            detail: `File ${file.name} has unsupported extension .${ext}`,
          },
          415,
        );
      }

      if (file.size > MAX_DOCUMENT_BYTES) {
        return c.json(
          {
            error: 'file_too_large',
            detail: `File ${file.name} exceeds ${MAX_DOCUMENT_BYTES} bytes.`,
          },
          413,
        );
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const dataBase64 = Buffer.from(bytes).toString('base64');

      fileDataList.push({
        fileName: file.name,
        fileData: dataBase64,
        mimeType: file.type || '',
      });
    }

    const queueRef = await resolveQueue();
    if (!queueRef) {
      return c.json(
        { error: 'queue-not-wired', detail: 'No batch queue is attached to this plane.' },
        503,
      );
    }

    try {
      const batchJob = await queueRef.create(tenantId, userId, fileDataList);

      return c.json(
        {
          batchId: batchJob.batchId,
          totalFiles: batchJob.totalFiles,
          status: 'queued',
          message: `${batchJob.totalFiles} files queued for batch processing.`,
          files: batchJob.files.map(f => ({
            fileId: f.fileId,
            fileName: f.fileName,
            status: f.status,
          })),
        },
        202,
      );
    } catch (err) {
      return c.json(
        { error: 'batch_create_failed', detail: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  app.get('/status/:batchId', async (c) => {
    const gate = await auth(c);
    if ('error' in gate) return gate.error;

    const batchId = c.req.param('batchId');
    if (!batchId) {
      return c.json({ error: 'batchId_required' }, 400);
    }

    const queueRef = await resolveQueue();
    if (!queueRef) {
      return c.json(
        { error: 'queue-not-wired', detail: 'No batch queue is attached to this plane.' },
        503,
      );
    }

    try {
      const batch = queueRef.get(batchId);
      if (!batch) {
        return c.json({ error: 'batch_not_found' }, 404);
      }

      if (batch.tenantId !== gate.identity.tenantId) {
        return c.json({ error: 'forbidden' }, 403);
      }

      const progress = queueRef.progress(batchId);

      return c.json({
        batchId: batch.batchId,
        status: batch.completedAt ? 'completed' : 'processing',
        totalFiles: batch.totalFiles,
        processedFiles: batch.processedFiles,
        failedFiles: batch.failedFiles,
        progress,
        files: batch.files,
        createdAt: batch.createdAt,
        completedAt: batch.completedAt,
      });
    } catch (err) {
      return c.json(
        { error: 'status_check_failed', detail: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  app.get('/', async (c) => {
    const gate = await auth(c);
    if ('error' in gate) return gate.error;

    const queueRef = await resolveQueue();
    if (!queueRef) {
      return c.json(
        { error: 'queue-not-wired', detail: 'No batch queue is attached to this plane.' },
        503,
      );
    }

    try {
      const batches = queueRef.list(gate.identity.tenantId);
      return c.json({
        batches: batches.map(b => ({
          batchId: b.batchId,
          totalFiles: b.totalFiles,
          processedFiles: b.processedFiles,
          failedFiles: b.failedFiles,
          createdAt: b.createdAt,
          completedAt: b.completedAt,
        })),
        total: batches.length,
      });
    } catch (err) {
      return c.json(
        { error: 'list_failed', detail: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  return app;
}
