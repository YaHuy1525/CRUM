import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestServer, type TestServer } from '../helpers/test-server.js'
import type { DocumentQueueLike, DocumentJobSnapshot } from '../../src/api/documents.js'
import type { DocumentJobData } from '../../src/queue/document-queue.js'
import { runIntake } from '../../src/queue/intake-run.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const TENANT = '00000000-0000-4000-8000-000000000001'
const USER = '00000000-4000-8000-8000-000000000002'

const AUTH = {
  'x-tenant-id': TENANT,
  'x-user-id': USER,
  'x-user-role': 'admin',
}

/**
 * A synchronous mock queue that processes documents immediately by calling
 * runIntake directly. This avoids the need for Redis/BullMQ in integration tests.
 */
function createSyncMockQueue(): DocumentQueueLike & { jobs: Map<string, DocumentJobSnapshot> } {
  const jobs = new Map<string, DocumentJobSnapshot>()
  let jobCounter = 0

  return {
    jobs,
    async enqueue(data: DocumentJobData): Promise<string> {
      const jobId = `job-${++jobCounter}`
      const snapshot: DocumentJobSnapshot = {
        id: jobId,
        state: 'active',
        progress: 10,
        data,
        timestamp: Date.now(),
        processedOn: Date.now(),
      }
      jobs.set(jobId, snapshot)

      try {
        const result = await runIntake({
          tenantId: data.tenantId,
          ownerId: data.userId,
          title: data.fileName,
          mime: data.mimeType,
          source: data.source === 'api' ? 'upload' : data.source,
          sourceRef: null,
          dataBase64: data.fileData,
        })

        const completed: DocumentJobSnapshot = {
          id: jobId,
          state: 'completed',
          progress: 100,
          data,
          result: {
            documentId: result.documentId,
            status: result.status,
            kind: result.kind,
            confidence: result.confidence,
            chunkCount: result.chunkCount,
          },
          timestamp: snapshot.timestamp,
          processedOn: snapshot.processedOn,
          finishedOn: Date.now(),
        }
        jobs.set(jobId, completed)
      } catch (err) {
        const failed: DocumentJobSnapshot = {
          id: jobId,
          state: 'failed',
          progress: 0,
          data,
          failedReason: err instanceof Error ? err.message : String(err),
          timestamp: snapshot.timestamp,
          processedOn: snapshot.processedOn,
          finishedOn: Date.now(),
        }
        jobs.set(jobId, failed)
      }

      return jobId
    },

    status(jobId: string): Promise<DocumentJobSnapshot | null> {
      return Promise.resolve(jobs.get(jobId) ?? null)
    },
  }
}

/**
 * Build a FormData upload body using the native File API.
 */
function uploadForm(fileName: string, content: string, mimeType: string): FormData {
  const form = new FormData()
  const bytes = new TextEncoder().encode(content)
  form.set('file', new File([bytes], fileName, { type: mimeType }))
  return form
}

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? ''

describe.skipIf(url === '')('document audit flow integration', () => {
  let server: TestServer
  let mockQueue: ReturnType<typeof createSyncMockQueue>

  beforeAll(async () => {
    mockQueue = createSyncMockQueue()
    server = await createTestServer(mockQueue)
  })

  afterAll(async () => {
    await server.close()
  })

  it('uploads document, processes it, and populates audit trail', async () => {
    const fixturePath = join(__dirname, '../fixtures/invoice-sample.txt')
    const fileContent = await readFile(fixturePath, 'utf-8')

    const uploadRes = await server.fetch('/api/documents/upload', {
      method: 'POST',
      headers: AUTH,
      body: uploadForm('invoice-sample.txt', fileContent, 'text/plain'),
    })

    expect(uploadRes.status).toBe(202)
    const uploadBody = await uploadRes.json() as { jobId: string }
    expect(uploadBody.jobId).toBeDefined()

    const jobId = uploadBody.jobId

    // The mock queue processes synchronously, so the job should already be done.
    const statusRes = await server.fetch(`/api/documents/status/${jobId}`, {
      headers: AUTH,
    })
    const statusBody = await statusRes.json() as { state: string; result?: { documentId: string } }

    expect(statusBody.state).toBe('completed')
    const documentId = statusBody.result!.documentId

    // Verify audit trail is populated
    const auditRes = await server.fetch(`/api/documents/${documentId}/audit`, {
      headers: AUTH,
    })

    expect(auditRes.status).toBe(200)
    const auditBody = await auditRes.json() as { audit: Array<{ change_source: string; field_name: string }> }
    expect(auditBody.audit.length).toBeGreaterThan(0)

    // Verify extraction audits exist
    const extractionAudits = auditBody.audit.filter(a => a.change_source === 'extraction')
    expect(extractionAudits.length).toBeGreaterThan(0)

    // Verify field_confidence is present
    const docRes = await server.fetch(`/api/documents/${documentId}`, {
      headers: AUTH,
    })

    expect(docRes.status).toBe(200)
    const docBody = await docRes.json() as { document: { field_confidence?: Record<string, number> } }
    expect(docBody.document.field_confidence).toBeDefined()
    expect(Object.keys(docBody.document.field_confidence!).length).toBeGreaterThan(0)
  }, 60000)

  it('manual correction creates audit row with change_source=manual_correction', async () => {
    const fixturePath = join(__dirname, '../fixtures/invoice-sample.txt')
    const fileContent = await readFile(fixturePath, 'utf-8')

    const uploadRes = await server.fetch('/api/documents/upload', {
      method: 'POST',
      headers: AUTH,
      body: uploadForm('invoice-sample.txt', fileContent, 'text/plain'),
    })

    const uploadBody = await uploadRes.json() as { jobId: string }
    const jobId = uploadBody.jobId

    // The mock queue processes synchronously
    const statusRes = await server.fetch(`/api/documents/status/${jobId}`, {
      headers: AUTH,
    })
    const statusBody = await statusRes.json() as { state: string; result?: { documentId: string } }

    expect(statusBody.state).toBe('completed')
    const documentId = statusBody.result!.documentId

    // Apply manual correction
    const correctionRes = await server.fetch(`/api/documents/${documentId}/invoices/total`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...AUTH,
      },
      body: JSON.stringify({
        value: 9999.99,
        reason: 'Integration test correction',
      }),
    })

    expect(correctionRes.status).toBe(200)

    // Verify audit trail has the correction
    const auditRes = await server.fetch(`/api/documents/${documentId}/audit`, {
      headers: AUTH,
    })

    const auditBody = await auditRes.json() as {
      audit: Array<{
        change_source: string
        field_name: string
        new_value: string
        reason: string
      }>
    }
    const correctionAudit = auditBody.audit.find(
      a => a.change_source === 'manual_correction' && a.field_name === 'total'
    )

    expect(correctionAudit).toBeDefined()
    expect(String(correctionAudit!.new_value)).toBe('9999.99')
    expect(correctionAudit!.reason).toBe('Integration test correction')
  }, 60000)
})
