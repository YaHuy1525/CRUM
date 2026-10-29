import { describe, expect, it } from 'vitest'
import { parseCsv, parseProspectRows } from '../../../src/prospects/csv'
import { planImport, type ExistingProspect } from '../../../src/prospects/import'

const header = 'Business Name,Country,Category,Platform,Profile URL,Description,What They Sell,Price Range (AUD),Followers/Customers,Location,Contact Info,Notes'
const csv = [
  header,
  'Jo Green,Australia,Career,LinkedIn,https://au.linkedin.com/in/jo-green-coach,Career coach,1:1 program,"$2,100",3K LinkedIn,Sydney,jo@example.com,Flat price',
  'Tradie Coach (Paul Rogers),Australia,Trades,LinkedIn,https://au.linkedin.com/in/paul-rogers,A tradie coach,Coaching,Not published,3K LinkedIn,Adelaide,site,Army of one',
  'Tech and Tradie Coach (Joel Hayward),Australia,Trades,LinkedIn,https://au.linkedin.com/in/joel-hayward,Another tradie coach,Coaching,Not published,2K LinkedIn,Brisbane,site,Solo',
].join('\n')

const existing: ExistingProspect[] = [
  {
    id: 'existing-jo',
    name: 'Jo Green',
    country: 'AU',
    platform: 'linkedin',
    handleNormalized: 'jo-green-coach',
  },
]

describe('planImport', () => {
  it('skips a prospect whose platform and handle already exist', () => {
    const plan = planImport(parseProspectRows(parseCsv(csv)), existing)
    expect(plan.duplicates).toHaveLength(1)
    expect(plan.inserts.map((r) => r.name)).not.toContain('Jo Green')
  })

  it('keeps both tradie coaches and raises a candidate between them', () => {
    const plan = planImport(parseProspectRows(parseCsv(csv)), existing)
    expect(plan.inserts).toHaveLength(2)
    expect(plan.candidates).toHaveLength(1)
    expect(plan.candidates[0]?.reason).toBe('substring')
  })

  it('reports counts that add up to the file', () => {
    const plan = planImport(parseProspectRows(parseCsv(csv)), existing)
    expect(plan.counts.rowsIn).toBe(3)
    expect(plan.counts.rowsNew).toBe(2)
    expect(plan.counts.rowsDuplicate).toBe(1)
    expect(plan.counts.rowsCandidate).toBe(1)
  })

  it('is empty for an empty file', () => {
    const plan = planImport([], existing)
    expect(plan.inserts).toHaveLength(0)
    expect(plan.duplicates).toHaveLength(0)
    expect(plan.candidates).toHaveLength(0)
    expect(plan.counts).toEqual({ rowsIn: 0, rowsNew: 0, rowsDuplicate: 0, rowsCandidate: 0 })
  })

  it('rejects a row whose country is blank instead of importing it', () => {
    const withBlankCountry = [
      header,
      'Jo Green,Australia,Career,LinkedIn,https://au.linkedin.com/in/jo-green-coach,Career coach,1:1 program,"$2,100",3K LinkedIn,Sydney,jo@example.com,Flat price',
      'Ghost Coach,,Trades,LinkedIn,https://au.linkedin.com/in/ghost-coach,No country,Coaching,Not published,1K LinkedIn,Sydney,site,Unknown',
    ].join('\n')

    const rows = parseProspectRows(parseCsv(withBlankCountry))
    expect(rows.map((row) => row.name)).toEqual(['Jo Green'])

    const plan = planImport(rows, existing)
    expect(plan.inserts.map((row) => row.name)).not.toContain('Ghost Coach')
    expect(plan.counts.rowsIn).toBe(1)
  })

  it('plans no new rows when the same file is imported twice', () => {
    const rows = parseProspectRows(parseCsv(csv))
    const first = planImport(rows, [])
    expect(first.counts.rowsNew).toBe(3)

    const afterFirst: ExistingProspect[] = first.inserts.map((row, index) => ({
      id: `prospect-${index}`,
      name: row.name,
      country: row.country,
      platform: row.platform,
      handleNormalized: row.handleNormalized,
    }))
    const second = planImport(rows, afterFirst)

    expect(second.inserts).toHaveLength(0)
    expect(second.counts.rowsNew).toBe(0)
    expect(second.counts.rowsDuplicate).toBe(3)
  })

  it('keys each candidate on a prospect id or an insert index, never a name', () => {
    const plan = planImport(parseProspectRows(parseCsv(csv)), existing)
    const candidate = plan.candidates[0]
    expect(candidate?.leftProspectId).toBeNull()
    expect(candidate?.leftInsertIndex).toBe(0)
    expect(candidate?.rightInsertIndex).toBe(1)

    const byNameCsv = [
      header,
      'Jo,Australia,Career,Instagram,https://www.instagram.com/jo/,Career coach,Coaching,Not published,3K IG,Sydney,site,Short name',
    ].join('\n')
    const byName = planImport(parseProspectRows(parseCsv(byNameCsv)), existing)
    expect(byName.candidates).toHaveLength(1)
    expect(byName.candidates[0]?.leftProspectId).toBe('existing-jo')
    expect(byName.candidates[0]?.leftInsertIndex).toBeNull()
  })
})
