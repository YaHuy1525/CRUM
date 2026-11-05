import { runIntake } from '../../queue/intake-run.js';
import type { DocumentJobData } from '../../queue/document-queue.js';

export async function runDocumentIntake(data: DocumentJobData) {
  return runIntake({
    tenantId: data.tenantId,
    ownerId: data.userId,
    title: data.fileName,
    mime: data.mimeType,
    source: data.source === 'api' ? 'upload' : data.source,
    sourceRef: null,
    dataBase64: data.fileData,
  });
}
