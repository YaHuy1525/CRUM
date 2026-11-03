import { createHash } from 'crypto';

export interface LayoutFingerprint {
  documentType: string;
  blockPattern: string;
  tableCount: number;
  imageCount: number;
  headerPositions: number[];
  avgConfidence: number;
  sampleHash: string;
}

export interface LayoutCluster {
  id: string;
  fingerprint: LayoutFingerprint;
  documents: string[];
  avgConfidence: number;
  createdAt: Date;
  updatedAt: Date;
}

const layoutClusters = new Map<string, LayoutCluster>();

export function computeLayoutFingerprint(
  blocks: Array<{ block_type: string; bbox: [number, number, number, number] | null; confidence: number | null }>,
  documentType: string
): LayoutFingerprint {
  const tableCount = blocks.filter(b => b.block_type === 'table').length;
  const imageCount = blocks.filter(b => b.block_type === 'figure').length;
  const headerPositions = blocks
    .filter(b => b.block_type === 'header' || b.block_type === 'title')
    .map(b => b.bbox?.[1] ?? 0);
  
  const confidences = blocks.map(b => b.confidence ?? 0).filter(c => c > 0);
  const avgConfidence = confidences.length > 0
    ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length
    : 0;

  const pattern = blocks.map(b => `${b.block_type}:${b.bbox ? 'bbox' : 'no-bbox'}`).join('|');
  const sampleHash = createHash('sha256').update(pattern).digest('hex').substring(0, 16);

  return {
    documentType,
    blockPattern: pattern,
    tableCount,
    imageCount,
    headerPositions,
    avgConfidence,
    sampleHash,
  };
}

export function findMatchingCluster(fingerprint: LayoutFingerprint): LayoutCluster | null {
  for (const cluster of layoutClusters.values()) {
    if (cluster.fingerprint.sampleHash === fingerprint.sampleHash) {
      return cluster;
    }
    
    const similarity = computeSimilarity(cluster.fingerprint, fingerprint);
    if (similarity > 0.85) {
      return cluster;
    }
  }
  return null;
}

export function createOrUpdateCluster(
  fingerprint: LayoutFingerprint,
  documentId: string,
  extractionConfidence: number
): LayoutCluster {
  const existing = findMatchingCluster(fingerprint);
  
  if (existing) {
    existing.documents.push(documentId);
    existing.avgConfidence = (existing.avgConfidence * (existing.documents.length - 1) + extractionConfidence) / existing.documents.length;
    existing.updatedAt = new Date();
    return existing;
  }

  const cluster: LayoutCluster = {
    id: `cluster_${fingerprint.sampleHash}`,
    fingerprint,
    documents: [documentId],
    avgConfidence: extractionConfidence,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  layoutClusters.set(cluster.id, cluster);
  return cluster;
}

function computeSimilarity(a: LayoutFingerprint, b: LayoutFingerprint): number {
  if (a.documentType !== b.documentType) return 0;
  if (a.tableCount !== b.tableCount) return 0.5;
  if (a.imageCount !== b.imageCount) return 0.6;
  
  const headerSim = a.headerPositions.length === b.headerPositions.length
    ? 1.0
    : 0.5;
  
  const confSim = 1.0 - Math.abs(a.avgConfidence - b.avgConfidence);
  
  return (headerSim + confSim) / 2;
}

export function getClusterStats(): {
  totalClusters: number;
  avgDocumentsPerCluster: number;
  avgConfidence: number;
} {
  const clusters = Array.from(layoutClusters.values());
  const totalDocs = clusters.reduce((sum, c) => sum + c.documents.length, 0);
  const avgConf = clusters.reduce((sum, c) => sum + c.avgConfidence, 0) / clusters.length;

  return {
    totalClusters: clusters.length,
    avgDocumentsPerCluster: clusters.length > 0 ? totalDocs / clusters.length : 0,
    avgConfidence: clusters.length > 0 ? avgConf : 0,
  };
}

export function clearClusters(): void {
  layoutClusters.clear();
}
