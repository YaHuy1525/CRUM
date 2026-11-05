import { documentIntakeWorkflow } from '../mastra/workflows/document-intake.js';

export interface IntakeRunInput {
  tenantId: string;
  ownerId: string;
  title: string;
  mime: string;
  source: 'upload' | 'email';
  sourceRef: string | null;
  dataBase64: string;
}

export interface IntakeRunResult {
  documentId: string;
  status: 'ready' | 'needs_review' | 'failed';
  kind: string;
  confidence: number | null;
  chunkCount: number;
}

/**
 * Runs the intake workflow and returns its result, throwing when the run did
 * not succeed so the caller's queue marks the job failed and retries fire.
 */
export async function runIntake(input: IntakeRunInput): Promise<IntakeRunResult> {
  const run = await documentIntakeWorkflow.createRun();
  const outcome = await run.start({ inputData: input });

  if (outcome.status !== 'success' || !outcome.result) {
    const reason =
      outcome.status === 'failed' ? (outcome.error?.message ?? 'unknown error') : outcome.status;
    throw new Error(`Intake workflow did not succeed: ${reason}`);
  }

  const result = outcome.result;
  return {
    documentId: result.documentId,
    status: result.status,
    kind: result.kind,
    confidence: result.confidence,
    chunkCount: result.chunkCount,
  };
}
