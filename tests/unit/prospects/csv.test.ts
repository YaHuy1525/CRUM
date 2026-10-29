import { describe, expect, it } from 'vitest'
import { parseCsv, parseProspectRows } from '../../../src/prospects/csv'

describe('parseCsv', () => {
  it('handles quoted commas and escaped quotes', () => {
    const rows = parseCsv('a,b\n"one, two","he said ""hi"""')
    expect(rows).toEqual([['a', 'b'], ['one, two', 'he said "hi"']])
  })

  it('strips a BOM and tolerates CRLF', () => {
    const rows = parseCsv('\uFEFFa,b\r\n1,2\r\n')
    expect(rows[0]).toEqual(['a', 'b'])
    expect(rows[1]).toEqual(['1', '2'])
  })

  it('drops blank lines', () => {
    expect(parseCsv('a,b\n\n1,2\n')).toHaveLength(2)
  })
})

describe('parseProspectRows', () => {
  const header = 'Business Name,Country,Category,Platform,Profile URL,Description,What They Sell,Price Range (AUD),Followers/Customers,Location,Contact Info,Notes'

  it('maps the twelve field contract including the AUD price header', () => {
    const rows = parseCsv(`${header}\nJo Green,Australia,Career,LinkedIn,https://au.linkedin.com/in/jo-green-coach,Coach,1:1 program,"$2,100",3K LinkedIn,Sydney,jo@example.com,Flat price`
    )
    const [row] = parseProspectRows(rows)
    expect(row.name).toBe('Jo Green')
    expect(row.country).toBe('AU')
    expect(row.platform).toBe('linkedin')
    expect(row.price.minMinor).toBe(210000)
    expect(row.price.currency).toBe('AUD')
    expect(row.audience.count).toBe(3000)
    expect(row.audience.basis).toBe('linkedin_connections')
  })

  it('accepts the VND price header variant and maps Vietnam to VND', () => {
    const vnHeader = header.replace('(AUD)', '(VND)')
    const rows = parseCsv(`${vnHeader}\nTrần Minh Trang,Vietnam,Accounting,TikTok,https://www.tiktok.com/@trang,Teacher,MISA course,"2,900,000-3,500,000",22.7K TikTok,Online,0900,One page site`)
    const [row] = parseProspectRows(rows)
    expect(row.country).toBe('VN')
    expect(row.price.currency).toBe('VND')
    expect(row.price.minMinor).toBe(2900000)
    expect(row.audience.count).toBe(22700)
  })

  it('skips rows with no name or no profile URL', () => {
    const rows = parseCsv(`${header}\n,,,,\nFrank,Australia,Coach,Instagram,,Description,Sells,Not published,1K Instagram,Sydney,contact,note`)
    expect(parseProspectRows(rows)).toHaveLength(0)
  })
})
