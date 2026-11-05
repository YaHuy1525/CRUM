# Phase 1 Implementation: Async Workflow Execution

## Summary

Successfully implemented async document processing using BullMQ and Redis, matching Sola.ai's architecture pattern.

## Changes Made

### 1. Infrastructure Setup
- **Added dependencies**: `bullmq`, `ioredis`, `ws`, `@types/ws`
- **Created queue infrastructure**: `src/queue/document-queue.ts`
  - BullMQ queue with Redis connection
  - Job data types and result types
  - Queue event listeners for real-time updates
  - Helper functions: `queueDocumentProcessing()`, `getJobStatus()`

### 2. Worker Implementation
- **Created document worker**: `src/queue/document-worker.ts`
  - Processes jobs from the queue
  - Integrates with existing `documentIntakeWorkflow`
  - Progress tracking (5% → 10% → 90% → 100%)
  - Error handling with retry logic (3 attempts, exponential backoff)
  - Concurrency: 5 workers, rate limited to 10 jobs/minute

### 3. API Modifications
- **Updated document upload endpoint**: `src/api/documents.ts`
  - Changed from synchronous processing to async queue
  - Returns `jobId` immediately (HTTP 202 Accepted)
  - Added new endpoint: `GET /api/documents/status/:jobId`
  - Removed dependency on `getIntakeWorkflow` (now uses queue)

### 4. WebSocket Server
- **Created real-time updates**: `src/queue/websocket-server.ts`
  - WebSocket server at `/ws/documents`
  - Tenant-scoped connections (requires `tenantId` and `userId`)
  - Broadcasts events: `document.processing`, `document.completed`, `document.failed`
  - Integrated with API server lifecycle

### 5. Server Integration
- **Updated API server**: `src/api/serve.ts`
  - Starts document worker on server boot
  - Creates WebSocket server alongside HTTP server
  - Graceful shutdown: stops worker and closes WebSocket on SIGINT/SIGTERM

### 6. Frontend Updates
- **Modified DocumentManager component**: `console/components/DocumentManager.tsx`
  - Handles async upload response (receives `jobId`)
  - Polls job status every 2 seconds (max 60 attempts)
  - Shows processing jobs in UI with status badges
  - Auto-refreshes document list on completion
  - Displays progress notifications

## Architecture

```
User Upload → API (202 Accepted) → BullMQ Queue → Worker Pool → Document Workflow
                ↓                                                         ↓
           Returns jobId ←────────────────────────────────── Updates job status
                ↓                                                         ↓
         Frontend polls ←────────────────────────────────── WebSocket broadcasts
         /status/:jobId                                                  events
```

## Configuration

### Required Environment Variables
```bash
REDIS_URL=redis://localhost:6379  # Redis connection string
```

### Optional Configuration
- Queue retry attempts: 3 (exponential backoff, 2s delay)
- Worker concurrency: 5
- Rate limiter: 10 jobs/minute
- Job retention: 24h (completed), 7 days (failed)

## API Changes

### POST /api/documents/upload
**Before**: Synchronous processing, returns document details
**After**: Async queue, returns jobId

**Response (202 Accepted)**:
```json
{
  "jobId": "bullmq-job-id",
  "fileId": "tenant_timestamp_random",
  "status": "queued",
  "message": "Document queued for processing..."
}
```

### GET /api/documents/status/:jobId (NEW)
Returns job status and progress.

**Response**:
```json
{
  "id": "job-id",
  "state": "active|completed|failed|waiting",
  "progress": 50,
  "result": { "documentId": "...", "status": "completed", ... },
  "failedReason": null,
  "timestamp": 1234567890,
  "processedOn": 1234567890,
  "finishedOn": 1234567890
}
```

## WebSocket Events

Connect to: `ws://localhost:3000/ws/documents?tenantId=...&userId=...`

**Events**:
- `document.processing` - Job started
- `document.completed` - Job finished successfully
- `document.failed` - Job failed

## Testing Checklist

- [ ] Redis server running
- [ ] Upload document via API
- [ ] Verify jobId returned immediately
- [ ] Poll status endpoint shows progress
- [ ] Worker processes job successfully
- [ ] Document appears in list after completion
- [ ] WebSocket receives real-time updates
- [ ] Failed jobs show error messages
- [ ] Retry logic works on transient failures
- [ ] Frontend shows processing status
- [ ] Graceful shutdown stops worker

## Next Steps

Phase 2: Enhanced OCR & Layout Understanding
- Add standalone OCR service for images
- Integrate Tesseract or cloud OCR APIs
- Update document-intake workflow to route images

## Migration Notes

**Breaking Change**: The `/api/documents/upload` endpoint now returns a jobId instead of document details. Frontend code must be updated to poll for status.

**Backward Compatibility**: Existing document processing logic is unchanged. Only the execution model (sync → async) is different.

**Database**: No schema changes required.

**Dependencies**: Redis server must be running before starting the API server.
