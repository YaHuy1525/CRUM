import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/document-activities.js';
import type { DocumentJobData, DocumentJobResult } from '../../queue/document-queue.js';

type IntakeActivities = typeof activities;

const intakeActivities = proxyActivities<IntakeActivities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '2s',
    backoffCoefficient: 2,
  },
});

export async function documentProcessingWorkflow(
  data: DocumentJobData
): Promise<DocumentJobResult> {
  try {
    const intake = await intakeActivities.runDocumentIntake(data);
    return {
      documentId: intake.documentId,
      status: 'completed',
      kind: intake.kind,
      confidence: intake.confidence ?? undefined,
      chunkCount: intake.chunkCount,
    };
  } catch (error) {
    return {
      documentId: data.fileId,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
