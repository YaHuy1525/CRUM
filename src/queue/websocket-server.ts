import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { documentQueueEvents, documentQueue } from './document-queue.js';
import type { DocumentJobResult } from './document-queue.js';
import { IdentityError, resolveSocketIdentity } from '../mastra/identity.js';
import type { CrumEnv } from '../config/env.js';

interface TenantConnection extends WebSocket {
  tenantId?: string;
  userId?: string;
}

const connections = new Set<TenantConnection>();

export function createWebSocketServer(server: Server, env: CrumEnv): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws/documents' });

  wss.on('connection', (ws: TenantConnection, request) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    let identity: { tenantId: string; userId: string };
    try {
      identity = resolveSocketIdentity(url.searchParams, env);
    } catch (err) {
      const reason = err instanceof IdentityError ? err.reason : 'identity-failed';
      ws.close(1008, reason);
      return;
    }

    ws.tenantId = identity.tenantId;
    ws.userId = identity.userId;
    connections.add(ws);

    console.log(`[WebSocket] Client connected: tenant=${ws.tenantId}, user=${ws.userId}`);

    ws.on('close', () => {
      connections.delete(ws);
      console.log(`[WebSocket] Client disconnected: tenant=${ws.tenantId}, user=${ws.userId}`);
    });

    ws.on('error', (error) => {
      console.error(`[WebSocket] Error for tenant=${ws.tenantId}:`, error);
      connections.delete(ws);
    });

    ws.send(JSON.stringify({
      type: 'connected',
      message: 'WebSocket connection established',
    }));
  });

  documentQueueEvents.on('completed', ({ jobId, returnvalue }: { jobId: string; returnvalue: DocumentJobResult }) => {
    void (async () => {
      const job = await documentQueue.getJob(jobId);
      if (job) {
        broadcastToTenant(job.data.tenantId, {
          type: 'document.completed',
          jobId,
          documentId: returnvalue.documentId,
          status: returnvalue.status,
          kind: returnvalue.kind,
          confidence: returnvalue.confidence,
        });
      }
    })();
  });

  documentQueueEvents.on('failed', ({ jobId, failedReason }: { jobId: string; failedReason: string }) => {
    void (async () => {
      const job = await documentQueue.getJob(jobId);
      if (job) {
        broadcastToTenant(job.data.tenantId, {
          type: 'document.failed',
          jobId,
          fileId: job.data.fileId,
          error: failedReason,
        });
      }
    })();
  });

  documentQueueEvents.on('active', ({ jobId }: { jobId: string }) => {
    void (async () => {
      const job = await documentQueue.getJob(jobId);
      if (job) {
        broadcastToTenant(job.data.tenantId, {
          type: 'document.processing',
          jobId,
          fileId: job.data.fileId,
          fileName: job.data.fileName,
        });
      }
    })();
  });

  documentQueueEvents.on('progress', ({ jobId }: { jobId: string }) => {
    void (async () => {
      const job = await documentQueue.getJob(jobId);
      if (job) {
        broadcastToTenant(job.data.tenantId, {
          type: 'document.progress',
          jobId,
          fileName: job.data.fileName,
          progress: typeof job.progress === 'number' ? job.progress : 0,
        });
      }
    })();
  });

  console.log('[WebSocket] Document status WebSocket server initialized');

  return wss;
}

function broadcastToTenant(tenantId: string, message: object) {
  const payload = JSON.stringify(message);
  for (const ws of connections) {
    if (ws.tenantId === tenantId && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

export function broadcastToUser(tenantId: string, userId: string, message: object) {
  const payload = JSON.stringify(message);
  for (const ws of connections) {
    if (ws.tenantId === tenantId && ws.userId === userId && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

export function getConnectedClientsCount(): number {
  return connections.size;
}
