'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

type JobState = 'queued' | 'active' | 'completed' | 'failed';

interface LiveJob {
  jobId: string;
  fileName: string;
  state: JobState;
  progress: number;
  documentId?: string;
  kind?: string;
  confidence?: number | null;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

interface ServerMessage {
  type: 'connected' | 'document.processing' | 'document.progress' | 'document.completed' | 'document.failed';
  jobId?: string;
  fileName?: string;
  progress?: number;
  documentId?: string;
  status?: string;
  kind?: string;
  confidence?: number | null;
  error?: string;
}

function socketUrl(tenantId: string, userId: string): string | null {
  const origin = process.env.NEXT_PUBLIC_CRUM_WS_ORIGIN;
  if (!origin) {
    if (typeof window === 'undefined') return null;
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${window.location.host}/ws/documents?tenantId=${tenantId}&userId=${userId}`;
  }
  const base = origin.replace(/\/$/, '');
  return `${base}/ws/documents?tenantId=${tenantId}&userId=${userId}`;
}

function stateFor(message: ServerMessage, previous: JobState | undefined): JobState {
  if (message.type === 'document.completed') return 'completed';
  if (message.type === 'document.failed') return 'failed';
  if (message.type === 'document.progress' || message.type === 'document.processing') return 'active';
  return previous ?? 'queued';
}

function badgeVariant(state: JobState): 'success' | 'warning' | 'danger' | 'default' {
  if (state === 'completed') return 'success';
  if (state === 'failed') return 'danger';
  if (state === 'active') return 'warning';
  return 'default';
}

function elapsed(since: number, until?: number): string {
  const ms = (until ?? Date.now()) - since;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function DocumentProcessingDashboard() {
  const [jobs, setJobs] = useState<LiveJob[]>([]);
  const [live, setLive] = useState(false);
  const [notice, setNotice] = useState('');
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);

  const apply = useCallback((message: ServerMessage) => {
    // Hoisted out of the setJobs closure, where a property test on `message`
    // would not narrow. The server's `connected` ack carries no jobId, so this
    // also filters it out.
    const jobId = message.jobId;
    if (!jobId) return;
    setJobs((prev) => {
      const existing = prev.find((job) => job.jobId === jobId);
      const state = stateFor(message, existing?.state);
      const progress =
        typeof message.progress === 'number'
          ? message.progress
          : state === 'completed'
            ? 100
            : (existing?.progress ?? 0);

      if (!existing) {
        return [
          {
            jobId,
            fileName: message.fileName ?? 'Document',
            state,
            progress,
            documentId: message.documentId,
            kind: message.kind,
            confidence: message.confidence,
            error: message.error,
            startedAt: Date.now(),
            finishedAt: state === 'completed' || state === 'failed' ? Date.now() : undefined,
          },
          ...prev,
        ];
      }

      return prev.map((job) =>
        job.jobId === message.jobId
          ? {
              ...job,
              state,
              progress,
              fileName: message.fileName ?? job.fileName,
              documentId: message.documentId ?? job.documentId,
              kind: message.kind ?? job.kind,
              confidence: message.confidence ?? job.confidence,
              error: message.error ?? job.error,
              finishedAt: state === 'completed' || state === 'failed' ? Date.now() : job.finishedAt,
            }
          : job
      );
    });
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    const tenantId = process.env.NEXT_PUBLIC_CRUM_DEV_TENANT_ID ?? '';
    const userId = process.env.NEXT_PUBLIC_CRUM_DEV_USER_ID ?? '';
    if (!tenantId || !userId) {
      setNotice('This console was built without a dev identity, so the live lane has nothing to connect as.');
      return;
    }

    const connect = () => {
      const url = socketUrl(tenantId, userId);
      if (!url || unmountedRef.current) return;
      const socket = new WebSocket(url);
      socketRef.current = socket;
      socket.onopen = () => {
        setLive(true);
        setNotice('');
      };
      socket.onclose = (event: CloseEvent) => {
        setLive(false);
        // 1008 is a policy refusal (jwt mode has no verifiable handshake
        // identity, or the ids were rejected), so retrying cannot fix it.
        if (event.code === 1008) {
          setNotice(event.reason === 'missing-token'
            ? 'Live updates need CRUM_AUTH_MODE=dev; with jwt identity, poll the document status endpoint instead.'
            : 'The live lane refused this connection: check the tenant and user ids.');
          return;
        }
        setNotice('');
        if (!unmountedRef.current) {
          reconnectRef.current = setTimeout(connect, 5000);
        }
      };
      socket.onerror = () => setLive(false);
      socket.onmessage = (event) => {
        try {
          apply(JSON.parse(String(event.data)) as ServerMessage);
        } catch {
          // A non-JSON frame is not a status update; ignore it.
        }
      };
    };

    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      socketRef.current?.close();
    };
  }, [apply]);

  const active = jobs.filter((job) => job.state === 'active' || job.state === 'queued');
  const completed = jobs.filter((job) => job.state === 'completed');
  const failed = jobs.filter((job) => job.state === 'failed');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Processing queue</h2>
        <div className="flex items-center gap-2">
          <Badge variant={live ? 'success' : 'default'}>{live ? 'Live' : 'Offline'}</Badge>
          <span className="text-sm text-text-muted">
            {active.length} active, {completed.length} completed, {failed.length} failed
          </span>
        </div>
      </div>

      {notice ? (
        <p className="text-sm text-text-muted">{notice}</p>
      ) : null}

      {jobs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
          Upload a document to watch it move through the queue here.
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <div key={job.jobId} className="rounded-lg border border-border bg-bg-card p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-text-primary">{job.fileName}</span>
                  <Badge variant={badgeVariant(job.state)}>{job.state}</Badge>
                </div>
                <span className="text-xs text-text-muted">{elapsed(job.startedAt, job.finishedAt)}</span>
              </div>

              <div className="mb-2 flex items-center gap-2">
                <div className="h-2 w-full overflow-hidden rounded-full bg-bg-hover">
                  <div
                    className="h-full bg-accent transition-all duration-300"
                    style={{ width: `${job.progress}%` }}
                  />
                </div>
                <span className="w-10 text-right text-xs text-text-muted">{job.progress}%</span>
              </div>

              {job.state === 'completed' && job.documentId ? (
                <div className="text-xs text-text-secondary">
                  Document {job.documentId}
                  {job.kind ? ` · ${job.kind}` : ''}
                  {typeof job.confidence === 'number'
                    ? ` · ${Math.round(job.confidence * 100)}% confidence`
                    : ''}
                </div>
              ) : null}

              {job.state === 'failed' && job.error ? (
                <div className="text-xs text-danger">{job.error}</div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {jobs.length > 0 ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => setJobs([])}>
            Clear history
          </Button>
        </div>
      ) : null}
    </div>
  );
}
