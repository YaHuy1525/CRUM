import { computeLayoutFingerprint, findMatchingCluster, createOrUpdateCluster } from './layout-clustering.js';
import type { DocumentBlock } from './docling.js';

export interface AdaptiveExtractionConfig {
  minConfidence: number;
  maxRetries: number;
  confidenceThreshold: number;
}

const DEFAULT_CONFIG: AdaptiveExtractionConfig = {
  minConfidence: 0.5,
  maxRetries: 2,
  confidenceThreshold: 0.7,
};

export interface ExtractionAttempt {
  attempt: number;
  confidence: number;
  schema: string;
  prompt?: string;
  result?: Record<string, unknown>;
}

export interface AdaptiveExtractionResult {
  finalResult: Record<string, unknown>;
  finalConfidence: number;
  attempts: ExtractionAttempt[];
  usedCluster: boolean;
  clusterId?: string;
}

export async function adaptiveExtract<T extends Record<string, unknown>>(
  blocks: DocumentBlock[],
  documentType: string,
  documentId: string,
  extractFn: (prompt: string, schema: string) => Promise<{ result: T; confidence: number }>,
  schemas: Array<{ name: string; prompt: string }>,
  config: Partial<AdaptiveExtractionConfig> = {}
): Promise<AdaptiveExtractionResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const attempts: ExtractionAttempt[] = [];

  const fingerprint = computeLayoutFingerprint(blocks, documentType);
  const cluster = findMatchingCluster(fingerprint);

  let bestResult: T | null = null;
  let bestConfidence = 0;

  if (cluster && cluster.avgConfidence > cfg.confidenceThreshold) {
    const matchingSchema = schemas.find(s => 
      cluster.fingerprint.documentType.toLowerCase().includes(s.name.toLowerCase())
    ) ?? schemas[0];

    if (!matchingSchema) {
      throw new Error('No schemas available for extraction');
    }

    try {
      const { result, confidence } = await extractFn(matchingSchema.prompt, matchingSchema.name);
      attempts.push({
        attempt: 1,
        confidence,
        schema: matchingSchema.name,
        prompt: matchingSchema.prompt.substring(0, 100),
        result,
      });

      if (confidence > bestConfidence) {
        bestResult = result;
        bestConfidence = confidence;
      }

      if (confidence >= cfg.confidenceThreshold) {
        createOrUpdateCluster(fingerprint, documentId, confidence);
        return {
          finalResult: result,
          finalConfidence: confidence,
          attempts,
          usedCluster: true,
          clusterId: cluster.id,
        };
      }
    } catch (err) {
      console.warn(`[adaptive-extract] Cluster schema failed: ${String(err)}`);
    }
  }

  for (let i = 0; i < cfg.maxRetries && i < schemas.length; i++) {
    const schema = schemas[i % schemas.length];
    if (!schema) continue;

    try {
      const { result, confidence } = await extractFn(schema.prompt, schema.name);
      attempts.push({
        attempt: i + 1,
        confidence,
        schema: schema.name,
        prompt: schema.prompt.substring(0, 100),
        result,
      });

      if (confidence > bestConfidence) {
        bestResult = result;
        bestConfidence = confidence;
      }

      if (confidence >= cfg.confidenceThreshold) {
        break;
      }
    } catch (err) {
      console.warn(`[adaptive-extract] Schema ${schema.name} failed: ${String(err)}`);
      attempts.push({
        attempt: i + 1,
        confidence: 0,
        schema: schema.name,
        prompt: schema.prompt.substring(0, 100),
      });
    }
  }

  if (bestResult && bestConfidence >= cfg.minConfidence) {
    createOrUpdateCluster(fingerprint, documentId, bestConfidence);
  }

  return {
    finalResult: bestResult ?? {},
    finalConfidence: bestConfidence,
    attempts,
    usedCluster: cluster !== null,
    clusterId: cluster?.id,
  };
}

export function selectBestSchema(
  documentType: string,
  schemas: Array<{ name: string; keywords: string[] }>
): string {
  const typeLower = documentType.toLowerCase();
  
  for (const schema of schemas) {
    const matchCount = schema.keywords.filter(kw => typeLower.includes(kw.toLowerCase())).length;
    if (matchCount >= 2) {
      return schema.name;
    }
  }
  
  return schemas[0]?.name ?? 'generic';
}
