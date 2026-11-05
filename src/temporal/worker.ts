import { Worker, NativeConnection } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { fileURLToPath } from 'node:url';
import * as activities from './activities/document-activities.js';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE || 'default';
const TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE || 'document-processing';

let worker: Worker | null = null;
let connection: NativeConnection | null = null;
let runPromise: Promise<void> | null = null;

export async function startTemporalWorker(): Promise<void> {
  console.log('[Temporal] Connecting to Temporal server at', TEMPORAL_ADDRESS);

  connection = await NativeConnection.connect({
    address: TEMPORAL_ADDRESS,
  });

  worker = await Worker.create({
    connection,
    namespace: TEMPORAL_NAMESPACE,
    taskQueue: TEMPORAL_TASK_QUEUE,
    workflowsPath: fileURLToPath(
      new URL('./workflows/document-processing.js', import.meta.url)
    ),
    activities,
    maxConcurrentActivityTaskExecutions: 10,
  });

  console.log('[Temporal] Worker started, listening on task queue:', TEMPORAL_TASK_QUEUE);

  runPromise = worker.run().catch((err) => {
    console.error('[Temporal] Worker failed:', err);
    process.exit(1);
  });
}

export async function stopTemporalWorker(): Promise<void> {
  if (worker) {
    console.log('[Temporal] Stopping worker...');
    worker.shutdown();
    await runPromise;
    worker = null;
    runPromise = null;
  }
  if (connection) {
    await connection.close();
    connection = null;
  }
}

export async function getTemporalClient(): Promise<Client> {
  const connection = await Connection.connect({
    address: TEMPORAL_ADDRESS,
  });

  return new Client({
    connection,
    namespace: TEMPORAL_NAMESPACE,
  });
}

export async function submitDocumentWorkflow(data: {
  tenantId: string;
  userId: string;
  fileId: string;
  fileName: string;
  fileData: string;
  mimeType: string;
  source: 'upload' | 'email' | 'api';
}): Promise<string> {
  const client = await getTemporalClient();

  const handle = await client.workflow.start('documentProcessingWorkflow', {
    args: [data],
    taskQueue: TEMPORAL_TASK_QUEUE,
    workflowId: `doc-${data.fileId}-${Date.now()}`,
    workflowExecutionTimeout: '10 minutes',
  });

  console.log('[Temporal] Started workflow:', handle.workflowId);
  return handle.workflowId;
}

export async function getWorkflowStatus(workflowId: string): Promise<{
  status: string;
  result?: unknown;
  error?: string;
} | null> {
  const client = await getTemporalClient();

  try {
    const handle = client.workflow.getHandle(workflowId);
    const description = await handle.describe();
    const status = description.status.name;

    if (status === 'COMPLETED') {
      return { status, result: await handle.result() };
    }
    return { status };
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      return null;
    }
    throw err;
  }
}

export async function listWorkflows(tenantId?: string): Promise<Array<{
  workflowId: string;
  status: string;
  startTime: Date;
  closeTime?: Date;
}>> {
  const client = await getTemporalClient();

  const list = client.workflow.list({
    query: tenantId ? `ExecutionStatus = 'Running' AND TenantId = '${escapeQueryValue(tenantId)}'` : '',
  });

  const workflows: Array<{
    workflowId: string;
    status: string;
    startTime: Date;
    closeTime?: Date;
  }> = [];

  for await (const wf of list) {
    workflows.push({
      workflowId: wf.workflowId,
      status: wf.status.name,
      startTime: wf.startTime,
      closeTime: wf.closeTime,
    });
  }

  return workflows;
}

function escapeQueryValue(value: string): string {
  return value.replace(/'/g, "''");
}
