import { describe, expect, it } from 'vitest'
import { parseCsv, parseProspectRows } from '../../../src/prospects/csv'
import {
  buildChannelParams,
  buildSnapshotParams,
  importRefusals,
  inspectImportRows,
  planImport,
  type ExistingProspect,
} from '../../../src/prospects/import'

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

const noCountryHeader = 'Business Name,Category,Platform,Profile URL,Description,What They Sell,Price Range (AUD),Followers/Customers,Location,Contact Info,Notes'

describe('inspectImportRows', () => {
  it('keeps every row of a clean file and rejects nothing', () => {
    const inspection = inspectImportRows(parseCsv(csv))
    expect(inspection.rows.map((row) => row.name)).toEqual(parseProspectRows(parseCsv(csv)).map((row) => row.name))
    expect(inspection.rejected).toEqual([])
    expect(inspection.dataRows).toBe(3)
    expect(inspection.missingColumns).toEqual([])
    expect(importRefusals(inspection)).toEqual([])
  })

  it('reports a missing Country column and every row it cost', () => {
    const withoutCountry = [
      noCountryHeader,
      'Jo Green,Career,LinkedIn,https://au.linkedin.com/in/jo-green-coach,Career coach,1:1 program,"$2,100",3K LinkedIn,Sydney,jo@example.com,Flat price',
      'Tradie Coach (Paul Rogers),Trades,LinkedIn,https://au.linkedin.com/in/paul-rogers,A tradie coach,Coaching,Not published,3K LinkedIn,Adelaide,site,Army of one',
    ].join('\n')

    const inspection = inspectImportRows(parseCsv(withoutCountry))
    expect(inspection.rows).toHaveLength(0)
    expect(inspection.rejected).toHaveLength(2)
    expect(inspection.missingColumns).toEqual(['country'])
    expect(inspection.rejected[0]?.reason).toBe('blank country')

    const refusals = importRefusals(inspection)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toContain('refusing to import')
    expect(refusals[0]).toContain('country')
  })

  it('refuses a 312 row file whose countries are all unrecognised', () => {
    const rows = Array.from({ length: 312 }, (_, i) =>
      `Coach ${i + 1},NZ,Coaching,Instagram,https://www.instagram.com/coach-${i + 1},d,s,Not published,1K IG,Sydney,site,note`)
    const inspection = inspectImportRows(parseCsv([header, ...rows].join('\n')))

    expect(inspection.rows).toHaveLength(0)
    expect(inspection.rejected).toHaveLength(312)

    const refusals = importRefusals(inspection)
    expect(refusals[0]).toContain('no rows parsed')
    expect(refusals[0]).toContain('312')
    expect(refusals[0]).toContain('unrecognised country')
  })

  it('names the reason each rejected row was dropped', () => {
    const mixed = [
      header,
      'Jo Green,Australia,Career,LinkedIn,https://au.linkedin.com/in/jo-green-coach,Career coach,1:1 program,"$2,100",3K LinkedIn,Sydney,jo@example.com,Flat price',
      'Ghost,,Trades,LinkedIn,https://au.linkedin.com/in/ghost,No country,Coaching,Not published,1K LinkedIn,Sydney,site,Unknown',
      'Elsewhere,NZ,Coach,Instagram,https://www.instagram.com/elsewhere,d,s,Not published,1K IG,Auckland,site,note',
      ',Australia,Coach,Instagram,https://www.instagram.com/unlabelled,d,s,Not published,1K IG,Sydney,site,note',
      'No Site,Australia,Coach,Instagram,www.example.com,d,s,Not published,1K IG,Sydney,site,note',
    ].join('\n')

    const inspection = inspectImportRows(parseCsv(mixed))
    expect(inspection.dataRows).toBe(5)
    expect(inspection.rows.map((row) => row.name)).toEqual(['Jo Green'])
    expect(inspection.rejected).toEqual([
      { name: 'Ghost', reason: 'blank country' },
      { name: 'Elsewhere', reason: 'unrecognised country' },
      { name: '', reason: 'missing name' },
      { name: 'No Site', reason: 'non-http profile url' },
    ])
  })

  it('refuses a partial import and prints only the first five rejected names', () => {
    const rows = [
      'Jo Green,Australia,Career,LinkedIn,https://au.linkedin.com/in/jo-green-coach,Career coach,1:1 program,"$2,100",3K LinkedIn,Sydney,jo@example.com,Flat price',
      ...Array.from({ length: 6 }, (_, i) =>
        `Bad ${i + 1},NZ,Coach,Instagram,https://www.instagram.com/bad-${i + 1},d,s,Not published,1K IG,Sydney,site,note`),
    ]
    const inspection = inspectImportRows(parseCsv([header, ...rows].join('\n')))
    const refusals = importRefusals(inspection)

    expect(refusals[0]).toBe('refusing to import: 6 of 7 data rows were rejected')
    expect(refusals).toHaveLength(6)
    expect(refusals[1]).toContain('Bad 1')
    expect(refusals[5]).toContain('Bad 5')
    expect(refusals.join('\n')).not.toContain('Bad 6')
  })

  it('refuses a header with no data rows', () => {
    const inspection = inspectImportRows(parseCsv(header))
    expect(inspection.dataRows).toBe(0)
    expect(importRefusals(inspection)).toEqual([
      'refusing to import: no rows parsed; the file has a header and no data rows',
    ])
  })
})

describe('buildChannelParams', () => {
  it('orders parameters like the prospect_channels insert', () => {
    const [jo] = parseProspectRows(parseCsv(csv))
    if (!jo) throw new Error('expected a parsed row')

    expect(buildChannelParams(jo, 'prospect-1', 'tenant-1')).toEqual([
      'tenant-1',
      'prospect-1',
      'linkedin',
      'jo-green-coach',
      'jo-green-coach',
      'https://au.linkedin.com/in/jo-green-coach',
      3000,
      'linkedin_connections',
      'exact',
    ])
  })
})

describe('buildSnapshotParams', () => {
  it('orders parameters like the prospect_snapshots insert', () => {
    const [jo] = parseProspectRows(parseCsv(csv))
    if (!jo) throw new Error('expected a parsed row')

    // extractor_version is a SQL literal, so the array stops at source_url.
    expect(buildSnapshotParams(jo, 'prospect-1', 'tenant-1')).toEqual([
      'tenant-1',
      'prospect-1',
      '1:1 program',
      210000,
      210000,
      'AUD',
      true,
      'https://au.linkedin.com/in/jo-green-coach',
    ])
  })

  it('passes a VND price through unscaled and an AUD price in cents', () => {
    const vnCsv = [
      header.replace('(AUD)', '(VND)'),
      'Trần Minh Trang,Vietnam,Accounting,TikTok,https://www.tiktok.com/@trang,Teacher,MISA course,"2,900,000-3,500,000",22.7K TikTok,Online,0900,One page site',
    ].join('\n')
    const [trang] = parseProspectRows(parseCsv(vnCsv))
    const [jo] = parseProspectRows(parseCsv(csv))
    if (!trang || !jo) throw new Error('expected two parsed rows')

    const vnd = buildSnapshotParams(trang, 'prospect-2', 'tenant-1')
    const aud = buildSnapshotParams(jo, 'prospect-1', 'tenant-1')

    // 2,900,000 VND has no minor unit; only AUD is multiplied by 100.
    expect(vnd[3]).toBe(2900000)
    expect(vnd[4]).toBe(3500000)
    expect(vnd[5]).toBe('VND')
    expect(aud[3]).toBe(210000)
    expect(aud[5]).toBe('AUD')
  })

  it('marks a row with no published price as not visible', () => {
    const [paul] = parseProspectRows(parseCsv(csv)).slice(1)
    if (!paul) throw new Error('expected a parsed row')

    const params = buildSnapshotParams(paul, 'prospect-3', 'tenant-1')
    expect(params[3]).toBeNull()
    expect(params[4]).toBeNull()
    expect(params[6]).toBe(false)
  })
})
