import { describe, expect, it } from 'vitest'
import { parseCsv, parseProspectRows, type ParsedRow } from '../../../src/prospects/csv'

function parseFirstRow(csv: string): ParsedRow {
  const [row] = parseProspectRows(parseCsv(csv))
  if (!row) throw new Error('expected one parsed row')
  return row
}

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
    const row = parseFirstRow(`${header}\nJo Green,Australia,Career,LinkedIn,https://au.linkedin.com/in/jo-green-coach,Coach,1:1 program,"$2,100",3K LinkedIn,Sydney,jo@example.com,Flat price`
    )
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
    const row = parseFirstRow(`${vnHeader}\nTrần Minh Trang,Vietnam,Accounting,TikTok,https://www.tiktok.com/@trang,Teacher,MISA course,"2,900,000-3,500,000",22.7K TikTok,Online,0900,One page site`)
    expect(row.country).toBe('VN')
    expect(row.price.currency).toBe('VND')
    expect(row.price.minMinor).toBe(2900000)
    expect(row.audience.count).toBe(22700)
  })

  it('maps an explicit VN country and keeps the VND price unscaled', () => {
    const row = parseFirstRow(`${header}\nTrang Le,VN,Accounting,TikTok,https://www.tiktok.com/@trangle,Teacher,Course,"2,900,000",10K TikTok,Online,0900,note`)
    expect(row.country).toBe('VN')
    expect(row.price.currency).toBe('VND')
    expect(row.price.minMinor).toBe(2900000)
    expect(row.price.maxMinor).toBe(2900000)
  })

  it('rejects a row whose country is blank instead of defaulting to AU', () => {
    const rows = parseCsv(`${header}\nNo Country,,Coach,Instagram,https://www.instagram.com/no-country,Description,Sells,"$2,100",1K Instagram,Sydney,contact,note`)
    expect(parseProspectRows(rows)).toHaveLength(0)
  })

  it('accepts the documented country spellings in any case', () => {
    const aus = parseFirstRow(`${header}\nJo,AUS,x,Instagram,https://www.instagram.com/jo-aus,d,s,"$2,100",1K,loc,c,n`)
    expect(aus.country).toBe('AU')
    const viet = parseFirstRow(`${header}\nTrang,việt,x,TikTok,https://www.tiktok.com/@trang-viet,d,s,"2,900,000",1K,loc,c,n`)
    expect(viet.country).toBe('VN')
    expect(viet.price.minMinor).toBe(2900000)
  })

  it('imports "Australia (also Dubai)" as AU', () => {
    const row = parseFirstRow(`${header}\nJo,Australia (also Dubai),Coach,Instagram,https://www.instagram.com/jo-dubai,d,s,"$2,100",1K,loc,c,n`)
    expect(row.name).toBe('Jo')
    expect(row.country).toBe('AU')
    expect(row.price.currency).toBe('AUD')
  })

  it('imports "Việt Nam (online)" as VN', () => {
    const row = parseFirstRow(`${header}\nTrang,Việt Nam (online),Teacher,TikTok,https://www.tiktok.com/@trang-online,d,s,"2,900,000",1K,loc,c,n`)
    expect(row.name).toBe('Trang')
    expect(row.country).toBe('VN')
    expect(row.price.currency).toBe('VND')
  })

  it('rejects a row whose country cell is the empty string', () => {
    const rows = parseCsv(`${header}\nNo Country,"",Coach,Instagram,https://www.instagram.com/no-country-empty,d,s,"$2,100",1K,loc,c,n`)
    expect(parseProspectRows(rows)).toHaveLength(0)
  })

  it('rejects a row whose country is unrecognised', () => {
    const rows = parseCsv(`${header}\nElsewhere,NZ,Coach,Instagram,https://www.instagram.com/elsewhere,Description,Sells,"$2,100",1K Instagram,Auckland,contact,note`)
    expect(parseProspectRows(rows)).toHaveLength(0)
  })

  it('skips rows with no name or no profile URL', () => {
    const rows = parseCsv(`${header}\n,,,,\nFrank,Australia,Coach,Instagram,,Description,Sells,Not published,1K Instagram,Sydney,contact,note`)
    expect(parseProspectRows(rows)).toHaveLength(0)
  })
})
