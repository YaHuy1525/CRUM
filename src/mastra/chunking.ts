export const CRUM_CHUNK_PARAMS = {
  strategy: 'recursive',
  maxSize: 900,
  overlap: 120,
  separators: ['\n\n', '\n', '. ', ' '],
  separatorPosition: 'end',
  addStartIndex: true,
} as const
