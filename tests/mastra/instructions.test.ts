import { describe, it, expect } from 'vitest'
import { CRUM_INSTRUCTIONS } from '../../src/mastra/instructions'
import { CRUM_WORKING_MEMORY_TEMPLATE } from '../../src/mastra/working-memory'

describe('CRUM instruction block', () => {
  it('contains the role section', () => {
    expect(CRUM_INSTRUCTIONS).toContain('<header role="presentation">')
    expect(CRUM_INSTRUCTIONS).toContain('CRUM, a conversational CRM')
  })

  it('contains the rules section with tool-use mandate', () => {
    expect(CRUM_INSTRUCTIONS).toContain('<section id="rules">')
    expect(CRUM_INSTRUCTIONS).toContain('Access and change data only through tools')
  })

  it('explains the why behind each rule', () => {
    // Claude prompting best practices: models generalize better from rules
    // with stated motivation, so every rule article carries a rationale.
    const articles = CRUM_INSTRUCTIONS.match(/<article>\s*<h3>/g) ?? []
    const whys = CRUM_INSTRUCTIONS.match(/<p class="why">/g) ?? []
    expect(articles.length).toBeGreaterThanOrEqual(5)
    expect(whys.length).toEqual(articles.length)
  })

  it('carries worked examples wrapped distinctly from instructions', () => {
    expect(CRUM_INSTRUCTIONS).toContain('<article class="example">')
    const examples = CRUM_INSTRUCTIONS.match(/<article class="example">/g) ?? []
    expect(examples.length).toBeGreaterThanOrEqual(3)
    expect(examples.length).toBeLessThanOrEqual(5)
  })

  it('contains the system-reminders section', () => {
    expect(CRUM_INSTRUCTIONS).toContain('<system-reminder>...</system-reminder>')
  })

  it('contains the output-format section', () => {
    expect(CRUM_INSTRUCTIONS).toContain('<section id="output_format">')
    expect(CRUM_INSTRUCTIONS).toContain('concise prose')
  })

  it('distinguishes tasks from schedules', () => {
    expect(CRUM_INSTRUCTIONS).toContain('concrete start and end time is a schedule')
  })

  it('names the marketing artifact contract the asset pass depends on', () => {
    // Without this paragraph the primary agent has no idea that the designer's
    // JSON has to reach save_bundle as a creative-designer / script artifact,
    // and generate_assets refuses with no_asset_prompts on a feature the owner
    // can see in the menu (spec section 7.2).
    expect(CRUM_INSTRUCTIONS).toContain('<section id="marketing">')
    expect(CRUM_INSTRUCTIONS).toContain('marketing.generate_assets')
    expect(CRUM_INSTRUCTIONS).toContain('creative-designer')
  })

  it('promises the staging refusal that now exists', () => {
    // Green on arrival, and deliberately so: the sentence has been in the
    // instruction since Task 7, so this is a seal rather than a RED. What it
    // buys is the direction that matters — a later edit that drops this sentence
    // while the arm stays has to pass this case on purpose. The behaviour half
    // lives in `tests/mastra/marketing-write-tools.test.ts`, where Step 1's first
    // case reads the refusal reason a human actually sees; a pin on prose cannot
    // detect a deleted arm, and pretending otherwise here would be the same
    // species of claim this task exists to stop. It cannot police the rest of the
    // paragraph either: a rewrite that keeps these words passes, which is why the
    // arm's own cases, not this one, are the contract.
    //
    // One line of the pinned sentence sits on one source line
    // (src/mastra/instructions.ts:99), so re-wrapping that prose breaks this case
    // with no change of meaning. Treat that failure as "the prose moved, restate
    // the pin", not as a lost refusal.
    expect(CRUM_INSTRUCTIONS).toContain(
      'staging refuses a bundle that still carries an unreviewed image',
    )
  })
})

describe('CRUM working memory template', () => {
  it('is a non-empty string', () => {
    expect(CRUM_WORKING_MEMORY_TEMPLATE.length).toBeGreaterThan(0)
  })

  it('contains the current focus section', () => {
    expect(CRUM_WORKING_MEMORY_TEMPLATE).toContain('## Current Focus')
  })

  it('contains the open commitments section', () => {
    expect(CRUM_WORKING_MEMORY_TEMPLATE).toContain('## Open Commitments')
  })

  it('contains the output preferences section', () => {
    expect(CRUM_WORKING_MEMORY_TEMPLATE).toContain('## Output Preferences')
  })

  it('teaches the agent when to fill and clear each block', () => {
    expect(CRUM_INSTRUCTIONS).toContain('Keeping working memory useful')
    expect(CRUM_INSTRUCTIONS).toContain('Never copy customer data that a tool can read live')
  })
})
