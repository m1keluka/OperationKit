#!/usr/bin/env tsx
/**
 * Build the knowledge-import starter pack's sample business files (obj 719936).
 *
 *   cd app/server && npx tsx src/scripts/make-sample-business-files.ts
 *
 * Writes four ENTIRELY FICTIONAL documents for a generic small services
 * business, "Cedar & Pine Home Services" (residential cleaning + handyman,
 * fictional city of Millbrook, ~14 staff), into
 * src/starter-packs/knowledge-import/sample-data/:
 *   - a deliberately messy multi-tab price list workbook (.xlsx)
 *   - the customer policies document (.pdf, 3 pages)
 *   - a weekly team meeting transcript (.txt)
 *   - the new-client onboarding SOP (.docx)
 *
 * No npm dependency: .xlsx/.docx are hand-built OOXML zipped with our own
 * writeZip(), and the PDF is a hand-written PDF 1.4 with Flate content streams.
 * Output is deterministic (fixed zip timestamps, no clocks, no randomness).
 *
 * The files cross-reference each other on purpose — and disagree in places —
 * so a Q&A demo can show "which source said what":
 *   - Deep Clean price: $289 (price list, effective 1/6/2025) vs $320 from
 *     April 1 (meeting transcript)
 *   - Cancellation: 24 hours / $40 fee (policies PDF) vs 48 hours / $50 fee
 *     (meeting transcript)
 *   - Quote turnaround: 2 business days (policies PDF) vs 1 business day (SOP)
 */
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { fileURLToPath } from 'url'
import { writeZip } from '../services/doc-ingest/zip.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(HERE, '../starter-packs/knowledge-import/sample-data')

function xmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Price List 2025 - FINAL v3.xlsx
// ═════════════════════════════════════════════════════════════════════════════

/** A real Excel date cell (rendered with built-in numFmt 14 = m/d/yyyy). */
interface DateCell { date: [number, number, number] }
type Cell = string | number | DateCell | null
type Row = Cell[]

const d = (y: number, m: number, day: number): DateCell => ({ date: [y, m, day] })

function excelSerial([y, m, day]: [number, number, number]): number {
  return Math.round((Date.UTC(y, m - 1, day) - Date.UTC(1899, 11, 30)) / 86400000)
}

function colLetter(i: number): string {
  let s = ''
  let n = i + 1
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
  return s
}

const SHEETS: Array<{ name: string; rows: Row[] }> = [
  {
    name: 'Cleaning',
    rows: [
      ['Cedar & Pine Home Services - Residential Cleaning Prices 2025  (FINAL v3 - use this one!!)'],
      ['Effective date:', d(2025, 1, 6), '', 'Questions -> Priya, office@cedarandpine.example, 555-0142'],
      [],
      ['Service', 'Home size', 'Price', 'Est. hours', 'Crew', 'Notes'],
      ['Standard Clean', 'Up to 1,200 sq ft', '$129', 2.5, 2, 'Kitchen, baths, dusting, floors'],
      ['Standard Clean', '1,200 - 2,000 sq ft', '$159', 3, 2, ''],
      ['Standard Clean', '2,000 - 3,000 sq ft', '$189', 3.5, 2, 'Over 3,000 sq ft = quote'],
      ['Deep Clean', 'Whole home (up to 2,500 sq ft)', '$289', 5, 2, 'Inside oven, baseboards, cabinet fronts, window sills. Effective 1/6/2025'],
      ['Move-in / Move-out Clean', 'Empty home', '$349', 6, 3, 'Inside fridge + cabinets included. Must be empty!'],
      [],
      ['Recurring - weekly', 'Any size', '15% off Standard', '', '', 'Must book min. 8 visits'],
      ['Recurring - every 2 weeks', 'Any size', '10% off Standard', '', '', ''],
      ['Recurring - monthly', 'Any size', '5% off Standard', '', '', 'Rosa wants to drop this tier? TBD'],
      ['Post-renovation clean', '', 'quote', '', 3, 'Dust is brutal, always walk through first'],
    ],
  },
  {
    name: 'Handyman',
    rows: [
      ['Item', 'Rate ($)', 'Unit', 'Min. charge', 'Who', 'Comments'],
      ['Hourly handyman labor', '89.00', 'per hour', '178.00', 'Tom / Andre', '2-hour minimum, materials extra'],
      ['TV wall mount (up to 65")', '149.00', 'each', '', 'Tom', 'Customer supplies bracket'],
      ['Furniture assembly', '75.00', 'per item', '', 'Andre', 'Large wardrobes = 2 items'],
      ['Drywall patch (small, under 6")', '120.00', 'each', '', 'Tom', 'Paint match not guaranteed'],
      ['Faucet replacement', '165.00', 'each', '', 'Tom', 'No gas lines, no main shutoff work - refer to plumber'],
      [],
      ['Gutter cleaning (1 story)', '140.00', 'per home', '', 'Andre', 'Seasonal, Oct-Nov rush'],
      ['Gutter cleaning (2 story)', '210.00', 'per home', '', 'Tom + Andre', 'Ladder policy: always 2 people'],
      ['Door / lock adjustment', '95.00', 'each', '', 'Tom', ''],
      ['Caulking (tub or shower)', '110.00', 'each', '', 'Andre', ''],
    ],
  },
  {
    name: 'Add-ons',
    rows: [
      ['Description', 'Cost', 'Applies to', 'Notes'],
      ['Inside fridge', '45 USD', 'Standard / Deep-clean (whole home)', 'Included free with Move-in / Move-out'],
      ['Inside oven', '40 USD', 'Standard only', 'Already included in Deep Clean'],
      ['Interior windows (per 10 panes)', '35 USD', 'Any', ''],
      ['Laundry - wash, dry, fold (per load)', '25 USD', 'Any', 'Customer detergent'],
      ['Pet hair surcharge', '30 USD', 'Any', 'Heavy shedding only - office decides at booking'],
      ['Same-day booking', '50 USD', 'Any', 'Only if a crew is free'],
      ['Garage sweep-out', '60 USD', 'Any', ''],
      ['Deep-clean (whole home) upgrade from Standard', '130 USD', 'Recurring clients', 'Price diff, recheck when Deep Clean price changes'],
    ],
  },
  {
    name: 'OLD 2024 prices',
    rows: [
      ['** OLD - DO NOT QUOTE FROM THIS TAB - kept for reference **'],
      ['Effective', d(2024, 2, 1)],
      [],
      ['Service', 'Price', 'Notes'],
      ['Standard Clean (small)', 119, ''],
      ['Standard Clean (medium)', 149, ''],
      ['Standard Clean (large)', 179, ''],
      ['Deep-clean (whole home)', 259, 'Raised to 289 for 2025'],
      ['Move-out clean', 319, ''],
      ['Hourly handyman', 79, 'Raised to 89 for 2025'],
      ['TV mount', 129, ''],
    ],
  },
  {
    name: 'Commercial (draft)',
    rows: [
      ['DRAFT - commercial pricing, not approved yet (Marcus)'],
      [],
      ['Client', 'Service', 'Frequency', 'Rate', 'Status', 'Notes'],
      ['Maple Street Dental', 'Office clean, after hours', 'Weekly (evenings)', '$185 / visit?', 'Quote requested', 'Approx 2,400 sq ft, 3 exam rooms + waiting room. Wants evening slot after 6pm. Marcus to quote.'],
      ['Millbrook Yoga Collective', 'Studio clean + mirrors', 'Twice weekly', '$95 / visit', 'Trial', 'Started Feb 2025, 4-week trial'],
      ['(template)', 'Office clean', 'Weekly', '$0.08 / sq ft', '', 'Rough rule of thumb, min $120 / visit'],
    ],
  },
]

function buildXlsx(): Buffer {
  const strings: string[] = []
  const strIdx = new Map<string, number>()
  const si = (s: string) => {
    let i = strIdx.get(s)
    if (i === undefined) { i = strings.length; strings.push(s); strIdx.set(s, i) }
    return i
  }
  let totalRefs = 0

  const sheetXml = (rows: Row[]) => {
    const out: string[] = []
    rows.forEach((row, r) => {
      if (!row.length) return // a genuinely blank row — just skip the row number
      const cells: string[] = []
      row.forEach((cell, c) => {
        if (cell === null || cell === '') return
        const ref = `${colLetter(c)}${r + 1}`
        if (typeof cell === 'number') cells.push(`<c r="${ref}"><v>${cell}</v></c>`)
        else if (typeof cell === 'string') { totalRefs++; cells.push(`<c r="${ref}" t="s"><v>${si(cell)}</v></c>`) }
        else cells.push(`<c r="${ref}" s="1"><v>${excelSerial(cell.date)}</v></c>`)
      })
      out.push(`<row r="${r + 1}">${cells.join('')}</row>`)
    })
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheetData>${out.join('')}</sheetData></worksheet>`
  }

  const sheetFiles: Array<[string, string]> = SHEETS.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)])

  const sst = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${totalRefs}" uniqueCount="${strings.length}">` +
    strings.map(s => `<si><t xml:space="preserve">${xmlEsc(s)}</t></si>`).join('') + '</sst>'

  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'

  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' + SHEETS.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'

  const n = SHEETS.length
  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    SHEETS.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    `<Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>'

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    SHEETS.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>'

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>'

  return writeZip([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', wbRels],
    ...sheetFiles,
    ['xl/sharedStrings.xml', sst],
    ['xl/styles.xml', styles],
  ])
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Customer Policies - Cancellations, Refunds and Guarantees.pdf
// ═════════════════════════════════════════════════════════════════════════════

/** One line of page content: font (B = bold), size, x, y, and one or more text cells at x offsets. */
interface PdfLine { b?: boolean; size?: number; x?: number; text: string | Array<[number, string]> }
type PdfPage = PdfLine[]

const POLICY_PAGES: PdfPage[] = [
  [
    { b: true, size: 9, text: 'CEDAR & PINE HOME SERVICES  -  MILLBROOK  -  555-0142  -  office@cedarandpine.example' },
    { text: '' },
    { b: true, size: 20, text: 'Customer Policies' },
    { b: true, size: 12, text: 'Cancellations, Refunds and Guarantees' },
    { size: 9, text: 'Effective January 6, 2025  |  Approved by Rosa Delgado, Owner' },
    { text: '' },
    { text: 'Thank you for choosing Cedar & Pine Home Services. This document explains how booking, cancellations,' },
    { text: 'refunds and our satisfaction guarantee work. It applies to all residential cleaning and handyman visits.' },
    { text: 'Commercial clients are covered by their written service agreement where one exists.' },
    { text: '' },
    { b: true, size: 12, text: '1. Booking and Quotes' },
    { text: '-  You can book by phone (555-0142), by email (office@cedarandpine.example) or through our website.' },
    { text: '-  Standard Clean, Deep Clean and Move-in / Move-out Clean are booked at our published prices.' },
    { text: '-  For handyman work, post-renovation cleans and homes over 3,000 sq ft we send a written quote.' },
    { text: '-  We send written quotes within 2 business days of your enquiry. Quotes are valid for 30 days.' },
    { text: '-  Every booking is confirmed by email with the date, arrival window and the price.' },
    { text: '-  Our arrival window is 1 hour. If the crew is running late, the office will call or text you.' },
    { text: '' },
    { b: true, size: 12, text: '2. Cancellations and Rescheduling' },
    { text: 'Plans change, and we understand. To cancel or reschedule a visit, please give us at least 24 hours notice' },
    { text: 'before the start of your arrival window. Notice can be given by phone, email or text.' },
    { text: '' },
    { text: '-  Cancelled with 24 hours notice or more: no charge.' },
    { text: '-  Cancelled with less than 24 hours notice: a late-cancellation fee of $40 applies.' },
    { text: '-  If the crew arrives and cannot get in (locked out, no access), the visit counts as a late' },
    { text: '   cancellation and the $40 fee applies.' },
    { text: '-  We waive the fee for genuine emergencies (illness, family emergency, severe weather) at the' },
    { text: '   office\'s discretion.' },
    { text: '-  Recurring clients may skip one visit per quarter without a fee if notice is given 24 hours ahead.' },
    { text: '' },
    { text: 'If we have to cancel a visit (for example a crew member is ill), we will tell you as early as we can,' },
    { text: 'offer the next available slot and give you $20 off that visit.' },
  ],
  [
    { b: true, size: 12, text: '3. Our 48-Hour Re-clean Guarantee' },
    { text: 'If you are not happy with any part of a cleaning visit, tell us within 48 hours and we will come back' },
    { text: 'and re-clean the areas you are not happy with, free of charge. Please send photos if you can - it helps' },
    { text: 'the crew fix exactly what was missed.' },
    { text: '' },
    { text: '-  The re-clean is scheduled within 3 business days of your call.' },
    { text: '-  The guarantee covers the rooms and tasks that were part of the booked service.' },
    { text: '-  Handyman work is guaranteed for 90 days on workmanship (not on customer-supplied parts).' },
    { text: '' },
    { b: true, size: 12, text: '4. Refunds' },
    { text: 'Our first answer to a problem is always to fix it. A refund is considered when:' },
    { text: '-  a re-clean has been done and the problem is still not resolved, or' },
    { text: '-  we could not complete the booked service for reasons on our side.' },
    { text: '' },
    { text: 'Refunds can be partial or full and are approved by the owner, Rosa Delgado. Approved refunds are paid' },
    { text: 'back to the original payment method within 5 business days. We do not refund late-cancellation fees' },
    { text: 'except as described in section 2.' },
    { text: '' },
    { b: true, size: 12, text: '5. Damage and Insurance' },
    { text: 'Cedar & Pine is fully insured (general liability) and all staff are employees, not contractors.' },
    { text: '-  Please report any damage within 48 hours of the visit, with photos.' },
    { text: '-  We will repair, replace or reimburse at fair value, up to the limits of our insurance.' },
    { text: '-  We are not responsible for items that were already damaged, poorly secured, or for normal wear.' },
    { text: '-  Please put away cash, jewelry and small valuables before the visit.' },
    { text: '' },
    { b: true, size: 12, text: '6. Pets' },
    { text: 'We love pets. Please tell us about pets when booking so the crew can plan.' },
    { text: '-  Dogs that may be nervous with visitors should be kept in a separate room or crate during the visit.' },
    { text: '-  We do not clean litter boxes, cages or tanks.' },
    { text: '-  Homes with heavy shedding may have a pet hair surcharge, agreed at booking.' },
  ],
  [
    { b: true, size: 12, text: '7. Payment Terms' },
    { text: '-  A card is kept on file at booking. Payment is taken on the day the visit is completed.' },
    { text: '-  We accept all major cards and bank transfer. Cash and checks are accepted for recurring clients.' },
    { text: '-  Handyman jobs over $500 require a 25% deposit when the quote is accepted.' },
    { text: '-  Invoices for commercial clients are due within 14 days.' },
    { text: '-  Prices are reviewed once a year. We give at least 30 days notice of any price change.' },
    { text: '' },
    { b: true, size: 12, text: '8. Keys and Access' },
    { text: 'Keys and door codes are stored securely in the office and labelled with a code number, never your' },
    { text: 'address. Keys are returned on request or when a recurring service ends.' },
    { text: '' },
    { b: true, size: 12, text: '9. Questions and Complaints' },
    { text: 'Contact the office first: 555-0142 or office@cedarandpine.example (Monday to Friday, 8am - 5pm).' },
    { text: 'If you are still not satisfied, you can reach the owner directly:' },
    { text: [[0, 'Rosa Delgado, Owner'], [200, 'rosa@cedarandpine.example'], [380, '555-0117']] },
    { text: [[0, 'Marcus Webb, Operations Manager'], [200, 'marcus@cedarandpine.example'], [380, '555-0128']] },
    { text: '' },
    { size: 8, text: 'Cedar & Pine Home Services, 18 Orchard Lane, Millbrook. This policy replaces all earlier versions.' },
    { size: 8, text: 'All names, addresses, phone numbers and figures in this document are fictional sample data.' },
  ],
]

function pdfStr(s: string): string {
  return '(' + s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')'
}

function pageContent(lines: PdfPage, pageNo: number, pageCount: number): string {
  // One text object per page; every move is a relative Td from the previous
  // text position (dy != 0 = new line, dy == 0 = next table column).
  const ops: string[] = ['BT']
  const left = 60
  let cx = 0
  let cy = 0
  let curFont = ''
  let y = 740
  const moveTo = (x: number, ty: number) => { ops.push(`${x - cx} ${ty - cy} Td`); cx = x; cy = ty }
  const setFont = (f: string) => { if (f !== curFont) { ops.push(`${f} Tf`); curFont = f } }
  for (const line of lines) {
    const size = line.size ?? 10
    setFont(`${line.b ? '/F2' : '/F1'} ${size}`)
    if (typeof line.text === 'string') {
      if (!line.text) { y -= 8; continue }
      moveTo(left + (line.x ?? 0), y)
      ops.push(`${pdfStr(line.text)} Tj`)
    } else {
      for (const [x, t] of line.text) {
        if (!t) continue
        moveTo(left + x, y)
        ops.push(`${pdfStr(t)} Tj`)
      }
    }
    y -= Math.round(size * 1.45)
  }
  setFont('/F1 8')
  moveTo(left, 40)
  ops.push(`${pdfStr(`Cedar & Pine Home Services  |  Customer Policies (Jan 2025)  |  Page ${pageNo} of ${pageCount}`)} Tj`)
  ops.push('ET')
  return ops.join('\n') + '\n'
}

function buildPdf(): Buffer {
  const pages = POLICY_PAGES
  // Object numbering: 1 catalog, 2 pages, 3 F1, 4 F2, 5 info, then per page: page obj + content obj.
  const objs: Buffer[] = []
  const pageObjNums = pages.map((_, i) => 6 + i * 2)
  objs[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>')
  objs[2] = Buffer.from(`<< /Type /Pages /Kids [${pageObjNums.map(n => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  objs[3] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  objs[4] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
  objs[5] = Buffer.from(`<< /Title ${pdfStr('Customer Policies - Cancellations, Refunds and Guarantees')} /Author ${pdfStr('Cedar & Pine Home Services')} /Producer ${pdfStr('Cedar & Pine sample-data builder')} >>`)
  pages.forEach((p, i) => {
    const pageNum = pageObjNums[i]
    const content = zlib.deflateSync(Buffer.from(pageContent(p, i + 1, pages.length), 'latin1'))
    objs[pageNum] = Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageNum + 1} 0 R >>`,
    )
    objs[pageNum + 1] = Buffer.concat([
      Buffer.from(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`),
      content,
      Buffer.from('\nendstream'),
    ])
  })

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  let offset = chunks[0].length
  const offsets: number[] = []
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = offset
    const b = Buffer.concat([Buffer.from(`${n} 0 obj\n`), objs[n], Buffer.from('\nendobj\n')])
    chunks.push(b)
    offset += b.length
  }
  const xrefStart = offset
  let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`
  for (let n = 1; n < objs.length; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
  xref += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  chunks.push(Buffer.from(xref))
  return Buffer.concat(chunks)
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Team meeting transcript - 2025-03-04.txt
// ═════════════════════════════════════════════════════════════════════════════

const TRANSCRIPT_TURNS: Array<[string, string, string]> = [
  ['00:00:03', 'Rosa Delgado', 'Okay, let\'s get going, I know Tom has a job at ten. Four things today: pricing, the cancellation policy, Maple Street Dental, and hiring.'],
  ['00:00:12', 'Marcus Webb', 'Sounds good. Can we do Maple Street early? I need a decision on that one.'],
  ['00:00:16', 'Rosa Delgado', 'Let\'s do pricing first, it ties in. Priya, how are deep cleans going?'],
  ['00:00:21', 'Priya Nair', 'Busy. We did 31 deep cleans in February. But the crews are telling me they\'re running long. The price list says five hours, and most of them are taking closer to six, six and a half.'],
  ['00:00:38', 'Marcus Webb', 'Yeah, and that\'s with two people. At $289 we\'re basically breaking even on the bigger homes once you count drive time.'],
  ['00:00:47', 'Rosa Delgado', 'I looked at what the other companies in Millbrook charge. Most are between 300 and 350 for a whole-home deep clean. I think we go to $320.'],
  ['00:00:58', 'Priya Nair', 'From when? I have people booked into March at $289 already.'],
  ['00:01:03', 'Rosa Delgado', 'Anything already booked keeps the old price. New bookings at $320 starting April 1. That gives us the 30 days notice we promise in the policy.'],
  ['00:01:14', 'Marcus Webb', 'Agreed. Priya, can you update the price list? The FINAL v3 one still says 289.'],
  ['00:01:19', 'Priya Nair', 'Yes. I\'ll make a v4. And the add-ons tab has the upgrade price from Standard to Deep Clean, I\'ll fix that too.'],
  ['00:01:27', 'Rosa Delgado', 'Good. Decision: Deep Clean goes to $320 for new bookings from April 1. Next, cancellations.'],
  ['00:01:35', 'Priya Nair', 'So this is the big one for me. We had seven late cancellations in February. Most of them were the night before, like 8 or 9pm. Technically that\'s still more than 24 hours before a morning slot, or close to it, so no fee, but I can\'t fill the slot at 9pm.'],
  ['00:01:55', 'Marcus Webb', 'And the crew still gets paid for that time. We lose the whole visit.'],
  ['00:02:00', 'Rosa Delgado', 'What does everyone think about 48 hours?'],
  ['00:02:04', 'Tom Okafor', 'For handyman jobs 48 hours makes even more sense. If I\'ve bought parts for a job and they cancel the day before, that\'s a mess.'],
  ['00:02:13', 'Priya Nair', '48 hours would let me actually call the waitlist. And the $40 fee doesn\'t really sting. I\'d suggest $50.'],
  ['00:02:21', 'Rosa Delgado', 'Okay. 48 hours notice, $50 late-cancellation fee. Same emergency exception as now. Marcus, we need to update the customer policy document and the confirmation emails.'],
  ['00:02:33', 'Marcus Webb', 'I\'ll update the PDF. Do we tell existing recurring clients?'],
  ['00:02:37', 'Rosa Delgado', 'Yes, email everyone 30 days before it starts. Let\'s say the new cancellation rule starts April 1 as well, same as the price change, one email for both.'],
  ['00:02:48', 'Priya Nair', 'Got it. One email, both changes, goes out by Friday.'],
  ['00:02:53', 'Rosa Delgado', 'Maple Street Dental. Marcus.'],
  ['00:02:56', 'Marcus Webb', 'So Dr. Ellison\'s office manager called again. They want a weekly evening clean, after 6pm, the whole office. About 2,400 square feet, three exam rooms, the waiting room, two bathrooms and a break room. They want a contract, 12 months.'],
  ['00:03:15', 'Rosa Delgado', 'What did we pencil in on the draft tab? 185 a visit?'],
  ['00:03:19', 'Marcus Webb', 'That\'s my rough number, but I want to do a walkthrough first. Dental offices have extra requirements, like how the exam rooms are cleaned. I\'m not quoting a clinical clean, just the office areas and floors. I\'ll make that clear.'],
  ['00:03:33', 'Tom Okafor', 'Who would staff evenings? Nobody\'s on after five right now.'],
  ['00:03:37', 'Marcus Webb', 'That\'s the problem, and it links to hiring. I don\'t want to pull a day crew onto evenings.'],
  ['00:03:43', 'Rosa Delgado', 'Okay. Marcus, do the walkthrough this week and send them a written quote by Friday. Include the evening staffing in the price.'],
  ['00:03:51', 'Marcus Webb', 'Walkthrough Wednesday afternoon, quote out by Friday.'],
  ['00:03:55', 'Rosa Delgado', 'Hiring. We\'re at fourteen with Andre. I think we need one more cleaner.'],
  ['00:04:01', 'Priya Nair', 'Definitely. I\'m turning away about four or five bookings a week. And if Maple Street happens we need evening cover.'],
  ['00:04:09', 'Marcus Webb', 'I\'d hire one cleaner now, part-time evenings plus some day shifts, and see how Maple Street goes before a second.'],
  ['00:04:16', 'Rosa Delgado', 'Agreed. One more cleaner. Priya, can you post the job this week? Same pay as the others, $19 an hour to start.'],
  ['00:04:23', 'Priya Nair', 'Yes. I\'ll post it Thursday and do first interviews next week.'],
  ['00:04:28', 'Tom Okafor', 'Quick one from me. Gutter season was good last fall, but the ladder policy says two people for two-story homes. Can I get Andre on Tuesdays for that once spring starts?'],
  ['00:04:39', 'Marcus Webb', 'Yes, I\'ll block Tuesdays for you two from mid-April.'],
  ['00:04:43', 'Tom Okafor', 'Thanks. Also, the onboarding SOP says we quote handyman jobs within one business day. That\'s hard for me when I\'m out on jobs all day.'],
  ['00:04:52', 'Priya Nair', 'I can draft them from your photos and you just check the number. We said one business day in the SOP because people book whoever answers first.'],
  ['00:05:01', 'Rosa Delgado', 'Let\'s try that. Okay, action items. Priya, read them back?'],
  ['00:05:05', 'Priya Nair', 'Okay. One: I update the price list, Deep Clean to $320 for new bookings from April 1, including the add-ons tab. Two: Marcus updates the customer policy PDF, 48 hours notice and $50 fee from April 1. Three: I send one email to all recurring clients about both changes by Friday. Four: Marcus does the Maple Street Dental walkthrough Wednesday and sends the quote by Friday. Five: I post the cleaner job Thursday. Six: Marcus blocks Tuesdays for Tom and Andre from mid-April.'],
  ['00:05:38', 'Rosa Delgado', 'Perfect. Thanks everyone. Same time next week.'],
]

function buildTranscript(): string {
  const header = [
    'Title: Cedar & Pine Home Services - weekly team meeting',
    'Date: 2025-03-04 8:30 AM',
    'Duration: 5m 44s',
    'Attendees: Rosa Delgado (Owner), Marcus Webb (Operations Manager), Priya Nair (Office & Scheduling Lead), Tom Okafor (Lead Handyman)',
    'Recorded by: meeting notes app (auto-transcribed - may contain errors)',
    '',
    '--- Summary (auto-generated) ---',
    'Deep Clean price going from $289 to $320 for new bookings from April 1. Cancellation policy changing from 24 hours notice / $40 fee to 48 hours notice / $50 fee from April 1. Maple Street Dental wants a weekly evening office clean on a 12-month contract; Marcus to do a walkthrough Wednesday and send a quote by Friday. Hiring one more cleaner (part-time evenings + day shifts). Action items read back at the end.',
    '',
    '--- Transcript ---',
  ]
  return header.join('\n') + '\n' + TRANSCRIPT_TURNS.map(([t, who, text]) => `[${t}] ${who}: ${text}`).join('\n') + '\n'
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. SOP - New Client Onboarding.docx
// ═════════════════════════════════════════════════════════════════════════════

type DocBlock =
  | { h: 1 | 2; text: string }
  | { p: string }
  | { li: string }
  | { step: string }
  | { table: string[][] }

const ONBOARDING_SOP: DocBlock[] = [
  { h: 1, text: 'SOP - New Client Onboarding' },
  { p: 'Cedar & Pine Home Services, Millbrook. Version 2.1 - last updated February 10, 2025 by Priya Nair. Owner of this SOP: Marcus Webb (Operations Manager).' },
  { h: 2, text: 'Purpose' },
  { p: 'This SOP describes how we turn a new enquiry into a happy recurring client. It covers residential cleaning and handyman clients. Follow it for every new client so nobody falls through the cracks.' },
  { h: 2, text: 'Roles' },
  { li: 'Priya Nair (Office & Scheduling Lead): answers enquiries, sends quotes, books visits, makes the follow-up call.' },
  { li: 'Marcus Webb (Operations Manager): does walkthroughs, approves non-standard quotes, assigns crews.' },
  { li: 'Crew lead on the day: runs the first-visit checklist and reports back to the office.' },
  { h: 2, text: 'Steps' },
  { step: 'Enquiry. Log every enquiry (phone, email, website) in the client sheet the same day. Record name, address, phone, home size, pets, service wanted and how they heard about us.' },
  { step: 'Quote. Send a written quote within 1 business day of the enquiry. Standard Clean, Deep Clean and Move-in / Move-out use the current price list. Handyman jobs and homes over 3,000 sq ft need Marcus to approve the number.' },
  { step: 'Walkthrough. For homes over 3,000 sq ft, post-renovation cleans and all commercial clients, Marcus books a 20-minute walkthrough before the first visit.' },
  { step: 'Booking. Once the client accepts, book the visit, take a card on file and send the confirmation email with the date, the 1-hour arrival window, the price and a link to the customer policies.' },
  { step: 'First visit. The crew lead runs the first-visit checklist (below) and texts the office a short summary and any photos when finished.' },
  { step: 'Follow-up call. Priya calls the client 3 days after the first visit to ask how it went, remind them of the 48-hour re-clean guarantee, and offer recurring service.' },
  { h: 2, text: 'Summary table' },
  {
    table: [
      ['Step', 'Owner', 'Time'],
      ['1. Enquiry logged', 'Priya', 'Same day'],
      ['2. Written quote sent', 'Priya (Marcus approves non-standard)', 'Within 1 business day'],
      ['3. Walkthrough (if needed)', 'Marcus', '20 minutes, before first visit'],
      ['4. Booking + confirmation email', 'Priya', 'Within 1 hour of acceptance'],
      ['5. First-visit checklist', 'Crew lead', 'During first visit'],
      ['6. Follow-up call', 'Priya', '3 days after first visit'],
    ],
  },
  { h: 2, text: 'First-visit checklist' },
  { li: 'Introduce the crew by name and confirm the rooms and tasks booked.' },
  { li: 'Ask about pets, alarm codes, parking and any rooms that are off-limits.' },
  { li: 'Note any existing damage and take photos before starting.' },
  { li: 'Walk the client (or send photos) through the finished work before leaving.' },
  { li: 'Leave a thank-you card with the office number, 555-0142.' },
  { h: 2, text: 'Notes' },
  { p: 'If the client mentions a commercial space (office, studio, clinic), pass it to Marcus the same day - commercial pricing is on the "Commercial (draft)" tab of the price list and is not approved for quoting without him.' },
  { p: 'Questions about this SOP: office@cedarandpine.example. All names and figures in this document are fictional sample data.' },
]

function wRun(text: string, bold = false): string {
  return `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`
}

function buildDocx(): Buffer {
  const body: string[] = []
  for (const b of ONBOARDING_SOP) {
    if ('h' in b) body.push(`<w:p><w:pPr><w:pStyle w:val="Heading${b.h}"/></w:pPr>${wRun(b.text)}</w:p>`)
    else if ('p' in b) body.push(`<w:p>${wRun(b.p)}</w:p>`)
    else if ('li' in b) body.push(`<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${wRun(b.li)}</w:p>`)
    else if ('step' in b) body.push(`<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>${wRun(b.step)}</w:p>`)
    else {
      const cols = b.table[0].length
      const colW = Math.floor(9000 / cols)
      const rows = b.table.map((row, ri) =>
        '<w:tr>' + row.map(cell => `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/></w:tcPr><w:p>${cell ? wRun(cell, ri === 0) : ''}</w:p></w:tc>`).join('') + '</w:tr>')
      body.push(
        '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="9000" w:type="dxa"/>' +
        '<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/>' +
        '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/>' +
        '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="999999"/></w:tblBorders>' +
        '</w:tblPr><w:tblGrid>' + `<w:gridCol w:w="${colW}"/>`.repeat(cols) + '</w:tblGrid>' +
        rows.join('') + '</w:tbl>',
      )
      body.push('<w:p/>')
    }
  }
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${body.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`

  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="1F3A5F"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="1F3A5F"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>' +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>' +
    '</w:styles>'

  const numbering = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>' +
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\u2022"/><w:lvlJc w:val="left"/>' +
    '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>' +
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>' +
    '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>'

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '</Types>'
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>'
  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
    '</Relationships>'

  return writeZip([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['word/document.xml', document],
    ['word/_rels/document.xml.rels', docRels],
    ['word/styles.xml', styles],
    ['word/numbering.xml', numbering],
  ])
}

// ═════════════════════════════════════════════════════════════════════════════

export const SAMPLE_FILES = {
  xlsx: 'Price List 2025 - FINAL v3.xlsx',
  pdf: 'Customer Policies - Cancellations, Refunds and Guarantees.pdf',
  txt: 'Team meeting transcript - 2025-03-04.txt',
  docx: 'SOP - New Client Onboarding.docx',
} as const

function main(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outputs: Array<[string, Buffer]> = [
    [SAMPLE_FILES.xlsx, buildXlsx()],
    [SAMPLE_FILES.pdf, buildPdf()],
    [SAMPLE_FILES.txt, Buffer.from(buildTranscript(), 'utf8')],
    [SAMPLE_FILES.docx, buildDocx()],
  ]
  for (const [name, buf] of outputs) {
    fs.writeFileSync(path.join(OUT_DIR, name), buf)
    console.log(`wrote ${buf.length.toString().padStart(7)} bytes  ${name}`)
  }
}

main()
