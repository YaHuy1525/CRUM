/**
 * Shared chunk parameters for all ingest paths. §6.3.2.
 *
 * maxSize and overlap are in characters (lengthFunction defaults to character
 * count). 900 characters ≈ 160 tokens, which keeps a contract clause intact.
 * The v0.2 values of 512/50 were ~90 tokens — too small for useful retrieval.
 */
export const CRUM_CHUNK_PARAMS = {
  strategy: 'recursive',
  maxSize: 900,
  overlap: 120,
  separators: ['\n\n', '\n', '. ', ' '],
  separatorPosition: 'end',
  addStartIndex: true,
} as const
