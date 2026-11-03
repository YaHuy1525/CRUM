import { describe, it, expect } from 'vitest'
import {
  WriteClaimGuardProcessor,
  MUTATING_TOOLS,
  MUTATING_TOOL_IDS,
  claimsWrite,
} from '../../../src/mastra/processors/write-claim-guard'
import { providerToolName } from '../../../src/mastra/active-tools'
import { crumToolRegistry } from '../../../src/mastra/agent'
import { loadPolicy } from '../../../src/governance/policy'

// The policy is read through the same loader the runtime uses, so this file and
// src/mastra/processors/write-claim-guard.ts ask one source one question rather
// than maintaining a second parser that can disagree with the first.
const REGISTERED = Object.keys(crumToolRegistry)
const DECLARED_MUTATING = loadPolicy()
  .tools.tools.filter((tool) => tool.class !== 'read-only')
  .map((tool) => tool.name)

/**
 * Declared mutating, not callable. run.side-effect is a workflow label whose scope
 * is resolved at run time, and crm.bulk_import is declared in the policy and
 * implemented nowhere. Both belong in a test as a named backlog: a gap that is
 * written down stays a known hole, and a gap that disappears behind a filter nobody
 * checks becomes a blind spot.
 */
const DECLARED_BUT_NOT_CALLABLE = ['crm.bulk_import', 'run.side-effect']

describe('WriteClaimGuardProcessor', () => {
  it('has the correct id', () => {
    const proc = new WriteClaimGuardProcessor()
    expect(proc.id).toBe('crum-write-claim-guard')
  })

  it('MUTATING_TOOLS contains all mutating tools in provider-facing form', () => {
    // MUTATING_TOOLS holds the sanitized names (post Agent#formatTools), which is
    // what processOutputStep receives. Check via providerToolName so the
    // assertion tracks any future registry-id renames automatically.
    for (const id of MUTATING_TOOL_IDS) {
      expect(MUTATING_TOOLS.has(providerToolName(id))).toBe(true)
    }
    // Spot-check the actual names to guard against a providerToolName regression.
    expect(MUTATING_TOOLS.has('crm_create_customer')).toBe(true)
    expect(MUTATING_TOOLS.has('crm_log_followup')).toBe(true)
    expect(MUTATING_TOOLS.has('mail_draft')).toBe(true)
    expect(MUTATING_TOOLS.has('mail_send')).toBe(true)
  })

  it('MUTATING_TOOLS does not contain read-only tool names', () => {
    expect(MUTATING_TOOLS.has(providerToolName('crm.list_customers'))).toBe(false)
    expect(MUTATING_TOOLS.has(providerToolName('crm.get_customer'))).toBe(false)
    expect(MUTATING_TOOLS.has(providerToolName('knowledge.retrieve'))).toBe(false)
  })

  it('guards exactly the mutating tools the agent can actually call', () => {
    expect(MUTATING_TOOL_IDS.slice().sort()).toEqual(
      DECLARED_MUTATING.filter((name) => REGISTERED.includes(name)).sort(),
    )
  })

  it('guards nothing the registry does not hold', () => {
    // The assertion that would have caught R6 on its own. A guarded id that is not
    // a tool is not a bug in the guard, it is a bug in the lane it names, and this
    // makes that unmissable.
    for (const id of MUTATING_TOOL_IDS) {
      expect(REGISTERED).toContain(id)
    }
  })

  it('names every declared mutating tool the registry is missing', () => {
    expect(DECLARED_MUTATING.filter((name) => !REGISTERED.includes(name)).sort()).toEqual(
      DECLARED_BUT_NOT_CALLABLE.slice().sort(),
    )
  })
})

/**
 * `claimsWrite` is the guard's only trigger, so its vocabulary is the whole
 * behaviour. These cases exist because the earlier one matched a bare past
 * participle anywhere in the answer, which is what killed read-only turns: a
 * follow-up table is made of the words `Scheduled`, `Added` and `Sent`.
 */
describe('claimsWrite', () => {
  it.each([
    // Reporting stored data is not claiming authorship of a change.
    ['a follow-up table whose status cells read Scheduled', '| Acme Corp | Call | 2026-10-28T09:00:00Z | Scheduled | Email |\n| Nordwind | Meeting | 2026-10-29 | Scheduled | Call |'],
    ['a count of scheduled items', 'You have 12 followups scheduled for next week and 3 tasks overdue.'],
    ['a negative report about created tasks', 'No tasks were created this week.'],
    ['tag names appearing as data', 'The customer record has the tags added and removed on it.'],
    ['a sentence about today\'s schedule', 'Here is what is scheduled for today: nothing.'],
    ['the agent describing an existing appointment', 'I have a call scheduled with Grace on Friday.'],
  ])('does not trip on %s', (_label, text) => {
    expect(claimsWrite(text)).toBe(false)
  })

  it.each([
    ['first person past claim', 'I created a new customer named Acme Corp.'],
    ['first person contraction', "I've scheduled a call with Grace for Monday."],
    ['first person with auxiliaries', 'We have just logged the followup against Nordwind.'],
    ['a bare first person update', 'I updated the deadline.'],
    ['a completion passive about the record', 'The task has been deleted.'],
    ['a pluperfect passive about the record', 'The draft had been sent to the customer.'],
  ])('trips on a claimed write: %s', (_label, text) => {
    expect(claimsWrite(text)).toBe(true)
  })

  it('does not try to tell a past passive claim from a record report', () => {
    // Accepted gap: "was sent"/"were created" is also how stored rows are
    // described, and tripping on it is what broke every read-only turn.
    expect(claimsWrite('The two followups were scheduled last month.')).toBe(false)
    expect(claimsWrite('These drafts were sent by the digest run.')).toBe(false)
  })

  it('aborts with a retry when the answer claims a write but no mutating tool ran', () => {
    const calls: Array<{ reason: string; opts: unknown }> = []
    const args = {
      text: 'I created the customer.',
      toolCalls: [],
      steps: [],
      retryCount: 0,
      messages: [],
      abort: (reason: string, opts: unknown) => calls.push({ reason, opts }),
    } as never
    new WriteClaimGuardProcessor().processOutputStep(args)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.opts).toEqual({ retry: true, metadata: { reason: 'write-claim-without-tool' } })
  })

  it('leaves a read-only answer alone even though it uses write vocabulary', () => {
    const calls: string[] = []
    const args = {
      text: '| Scheduled | Email | 2026-10-28T09:00:00Z |',
      toolCalls: [{ toolName: providerToolName('crm.my_open_items') }],
      steps: [],
      retryCount: 0,
      messages: [],
      abort: (reason: string) => calls.push(reason),
    } as never
    new WriteClaimGuardProcessor().processOutputStep(args)
    expect(calls).toEqual([])
  })

  it('leaves a true report of a send alone now that crm.send_outreach is guarded', () => {
    const calls: string[] = []
    const args = {
      text: "I've sent the outreach to Nordwind.",
      toolCalls: [{ toolName: providerToolName('crm.send_outreach') }],
      steps: [],
      retryCount: 0,
      messages: [],
      abort: (reason: string) => calls.push(reason),
    } as never
    new WriteClaimGuardProcessor().processOutputStep(args)
    expect(calls).toEqual([])
  })
})
