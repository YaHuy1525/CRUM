// CRM short form the agent fills during use (spec §6). Pointers, not data
// copies — anything a tool can read live stays out of memory.
export const CRUM_WORKING_MEMORY_TEMPLATE = `
# Working Memory

## Current Focus
- Account:
- Thread Topic:

## Active Filters
-

## Relationship Tone
- (formal | casual | warm)

## Open Commitments
- [Item]: [Status]

## Output Preferences
- Format:
- Detail Level:
`.trim()
