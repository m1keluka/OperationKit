#!/usr/bin/env tsx
/**
 * Build the Knowledge Base Setup sample folder (obj 900556).
 *
 *   cd app/server && npx tsx src/scripts/make-kb-setup-sample.ts
 *
 * Writes src/services/kb-setup/sample-intake/: ~20 files in a realistic folder
 * tree for an ENTIRELY FICTIONAL small brand & web design studio, "Lumen &
 * Lark Studio". It is both the "Try with sample files" data in the UI and the
 * end-to-end test fixture, so it deliberately contains:
 *   - every file type the setup agent reads (md, txt, csv, xlsx, docx, pptx,
 *     pdf, html, json, vtt, srt);
 *   - an exact duplicate (Notes/Copy of SOP - Client onboarding.md);
 *   - files it must skip (an image, a zip);
 *   - an ambiguous name ("Sam" in one call, "Sam Whitaker" elsewhere) and a
 *     conflict (Care Plan is $180/month on the price list, $150 in a meeting).
 * It contains NO secret-shaped strings: the e2e test adds a file with fake
 * credentials at run time, so the OSS secret scan never sees one in the tree.
 *
 * No npm dependency: OOXML files are hand-built and zipped with writeZip(),
 * the PDF is a hand-written PDF 1.4. Output is deterministic.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { writeZip } from '../services/doc-ingest/zip.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '../services/kb-setup/sample-intake')

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

function xlsx(sheets: Array<{ name: string; rows: string[][] }>): Buffer {
  const col = (i: number) => String.fromCharCode(65 + i)
  const sheetXml = (rows: string[][]) => XML +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => /^-?\d+(\.\d+)?$/.test(v)
      ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>`
      : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`).join('') +
    '</sheetData></worksheet>'
  return writeZip([
    ['[Content_Types].xml', XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>'],
    ['_rels/.rels', XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', XML + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + '</Relationships>'],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)] as [string, string]),
  ])
}

function docx(paras: string[]): Buffer {
  const body = paras.map(p => p.startsWith('# ')
    ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(p.slice(2))}</w:t></w:r></w:p>`
    : `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join('')
  return writeZip([
    ['[Content_Types].xml', XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', XML + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`],
  ])
}

function pptx(slides: Array<{ title: string; bullets: string[]; notes?: string }>): Buffer {
  const sp = (paras: string[]) => `<p:sp><p:txBody>${paras.map(t => `<a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`
  const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
  const files: Array<[string, string]> = [
    ['[Content_Types].xml', XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'],
    ['ppt/presentation.xml', XML + `<p:presentation ${NS}/>`],
  ]
  slides.forEach((s, i) => {
    files.push([`ppt/slides/slide${i + 1}.xml`, XML + `<p:sld ${NS}><p:cSld><p:spTree>${sp([s.title])}${sp(s.bullets)}</p:spTree></p:cSld></p:sld>`])
    if (s.notes) files.push([`ppt/notesSlides/notesSlide${i + 1}.xml`, XML + `<p:notes ${NS}><p:cSld><p:spTree>${sp([s.notes, String(i + 1)])}</p:spTree></p:cSld></p:notes>`])
  })
  return writeZip(files)
}

function pdf(pages: string[][]): Buffer {
  const objs: string[] = []
  const add = (s: string) => { objs.push(s); return objs.length }
  const catalog = add('')
  const pagesObj = add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const kids: number[] = []
  for (const lines of pages) {
    const content = ['BT', '/F1 11 Tf', '14 TL', '56 760 Td', ...lines.map(l => `(${l.replace(/[\\()]/g, m => `\\${m}`)}) Tj T*`), 'ET'].join('\n')
    const c = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`)
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`))
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

// A 1x1 transparent PNG and an empty zip: files the agent must skip.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex')

const SOP = `# SOP - Client onboarding

Owner: Priya Raman (project manager). Last reviewed March 2026.

## Steps
1. Within 1 business day of a signed proposal, Priya sends the welcome email and the intake form.
2. Book the kickoff call (60 minutes) with the client's decision-maker and Maya Lindqvist.
3. Create the project folder and the shared board; invite the client.
4. Collect brand assets (logo files, fonts, existing site logins via the client's password manager — never by email).
5. Send the first invoice (50% deposit) — see "How we invoice".
6. Theo Okonkwo starts discovery once the deposit is paid.

## Rules
- No work starts before the deposit is paid.
- Every client gets one named point of contact at the studio.
`

const files: Record<string, string | Buffer> = {
  'README.md': '# Sample folder for Knowledge Base Setup\n\nFictional files for "Lumen & Lark Studio". Built by src/scripts/make-kb-setup-sample.ts — do not edit by hand.\n',

  'Company/About Lumen & Lark Studio.md': `# About Lumen & Lark Studio

Lumen & Lark Studio is a four-person brand and web design studio founded in 2019 by Maya Lindqvist.
We design brands and build websites for local independent businesses — bakeries, clinics, shops and studios.

- Founder & creative director: Maya Lindqvist
- Designer: Theo Okonkwo
- Project manager: Priya Raman
- Developer (contract): Jonas Feld
- Printing partner: Copperline Print
`,

  'Company/Team directory.csv': `Name,Role,Email,Started,Reports to
Maya Lindqvist,Founder & creative director,maya@lumenlark.example,2019-02-01,
Theo Okonkwo,Senior designer,theo@lumenlark.example,2021-06-14,Maya Lindqvist
Priya Raman,Project manager,priya@lumenlark.example,2023-01-09,Maya Lindqvist
Jonas Feld,Contract web developer,jonas@feld.example,2024-03-01,Priya Raman
`,

  'Company/Glossary.txt': `Studio glossary

Brand Starter - our entry brand package (logo, palette, type, one-page guide).
Care Plan - monthly website maintenance and small edits.
Discovery - the first paid week of a project: interviews, audit, moodboard.
Handoff pack - the zip of final files we give a client at the end.
PM - project manager (Priya).
`,

  'Clients/Client list.xlsx': xlsx([
    { name: 'Active', rows: [['Client', 'Contact', 'Since', 'Services', 'Status'], ['Harbor Bakery', 'Sam Whitaker', '2025-11', 'Website Build, Care Plan', 'Active'], ['Pinecrest Dental', 'Dr. Lena Ortiz', '2026-02', 'Brand Starter', 'Proposal sent']] },
    { name: 'Past', rows: [['Client', 'Contact', 'Finished', 'Services'], ['Oak & Ember Cafe', 'Rui Costa', '2024-08', 'Brand Starter']] },
  ]),

  'Clients/Harbor Bakery/Statement of work - Harbor Bakery website.docx': docx([
    '# Statement of work — Harbor Bakery website',
    'Client: Harbor Bakery (owner: Sam Whitaker). Studio: Lumen & Lark Studio.',
    'Scope: a 6-page website with online cake pre-orders, built by Jonas Feld and designed by Theo Okonkwo.',
    'Fee: $7,800 fixed, invoiced 50% on signing and 50% at launch.',
    'Timeline: kickoff 2 March 2026, launch target 17 April 2026.',
    'After launch the client moves to the Care Plan.',
  ]),

  'Clients/Harbor Bakery/Kickoff call 2026-03-02.vtt': `WEBVTT

00:00:05.000 --> 00:00:12.000
<v Maya Lindqvist>Thanks for joining. Sam, you mentioned pre-orders are the priority?

00:00:12.500 --> 00:00:21.000
<v Sam>Yes — half our weekend orders come by phone. We want people to order cakes online two days ahead.

00:00:21.500 --> 00:00:30.000
<v Priya Raman>Then we launch pre-orders first and the blog later. Launch target stays April 17.

00:00:30.500 --> 00:00:38.000
<v Sam>Great. And the photos — our cousin shoots them, we'll send them by the 20th.
`,

  'Clients/Pinecrest Dental/Proposal - Pinecrest Dental rebrand.pptx': pptx([
    { title: 'Pinecrest Dental — rebrand proposal', bullets: ['Prepared for Dr. Lena Ortiz', 'Lumen & Lark Studio, February 2026'] },
    { title: 'What we will do', bullets: ['Brand Starter package', 'New logo, palette and type', 'Signage files for the new clinic sign'], notes: 'Lena cares most about the sign being ready before the June reopening.' },
    { title: 'Price and timing', bullets: ['Brand Starter: $3,200', 'Signage add-on: $600', 'Six weeks from deposit'] },
  ]),

  'Clients/Pinecrest Dental/Email thread - scope change.txt': `From: Lena Ortiz
To: Priya Raman
Date: 2026-02-24
Subject: Re: Pinecrest proposal

Hi Priya — we'd like to add the appointment cards to the rebrand. Can you quote that?

From: Priya Raman
To: Lena Ortiz
Date: 2026-02-25

Hi Lena, appointment cards are $250 for design; printing goes through Copperline Print at cost.
`,

  'Processes/SOP - Client onboarding.md': SOP,

  'Processes/How we invoice.md': `# How we invoice

- Projects: 50% deposit on signing, 50% at launch or handoff.
- Care Plans: billed monthly on the 1st.
- Since April 2026 all invoices go out monthly in one batch (see the decisions log).
- Payment terms: 14 days. Late reminders on day 15 and day 30, sent by Priya Raman.
`,

  'Processes/Project checklist.html': `<!doctype html><html><head><title>Project checklist</title><style>body{font:14px sans-serif}</style></head>
<body><h1>Project checklist</h1>
<h2>Before launch</h2><ul><li>Client sign-off on every page</li><li>Forms tested with a real email</li><li>Analytics installed</li></ul>
<h2>After launch</h2><ul><li>Handoff pack sent</li><li>Care Plan offered</li><li>Case study request (after 30 days)</li></ul>
<script>console.log('ignored')</script></body></html>
`,

  'Decisions/Decisions log 2026.md': `# Decisions log 2026

## 2026-01-12 — Stop fixed-price retainers
Decided by Maya Lindqvist. Retainers kept running over; new retainers are replaced by the Care Plan (fixed scope, monthly).

## 2026-03-30 — Move invoicing to monthly
Decided by Maya and Priya. From April 2026 all invoices go out on the 1st of the month in one batch instead of per milestone.
Why: fewer reminders, easier cash forecasting.
`,

  'Meetings/Weekly team meeting 2026-03-09.txt': `Weekly team meeting — 9 March 2026
Attendees: Maya Lindqvist, Theo Okonkwo, Priya Raman

- Harbor Bakery: design concepts approved by Sam. Jonas starts the build next week.
- Pinecrest Dental: waiting on the signed proposal. Lena asked for appointment cards.
- Care Plan price: Maya wants to keep it at $150/month for existing clients.
- Action: Theo to send Copperline Print the sign specs by Friday.
`,

  'Meetings/Weekly team meeting 2026-03-16.srt': `1
00:00:01,000 --> 00:00:06,000
Priya Raman: Harbor Bakery photos arrived, build is on track for April 17.

2
00:00:06,500 --> 00:00:12,000
Theo Okonkwo: Copperline quoted $340 for the Pinecrest sign print.

3
00:00:12,500 --> 00:00:18,000
Maya Lindqvist: OK. Let's also draft a case study once Harbor Bakery is live.
`,

  'Products/Price list 2026.csv': `Package,Price (USD),Billing,Includes
Brand Starter,3200,one-off,"Logo, palette, type, one-page brand guide"
Website Build,7800,one-off,"Up to 6 pages, CMS, contact form"
Care Plan,180,monthly,"Hosting, updates, 2 hours of edits"
Signage add-on,600,one-off,Print-ready sign files
`,

  'Products/Service packages.pdf': pdf([
    ['Lumen & Lark Studio - Service packages 2026', '', 'Brand Starter - $3,200', 'Logo, colour palette, type pairing and a one-page brand guide.', 'Takes about six weeks.', '', 'Website Build - from $7,800', 'Up to six pages on a CMS the client can edit.'],
    ['Care Plan - $180 per month', 'Hosting, updates, backups and two hours of edits each month.', 'Replaces the old fixed-price retainers.'],
  ]),

  'Exports/slack-export-general.json': JSON.stringify([
    { user: 'Priya Raman', ts: '2026-03-18T09:12:00Z', text: 'Reminder: Harbor Bakery launch is April 17, pre-orders first.' },
    { user: 'Theo Okonkwo', ts: '2026-03-18T09:14:00Z', text: 'Copperline can print the Pinecrest sign in 5 working days.' },
    { user: 'Maya Lindqvist', ts: '2026-03-18T09:20:00Z', text: 'lol nice' },
  ], null, 2),

  'Notes/Copy of SOP - Client onboarding.md': SOP,

  'Notes/Ideas.md': `# Ideas

- Offer a "Brand Starter + Website Build" bundle at $10,500.
- Ask Sam for a testimonial after launch.
`,

  'Misc/studio-logo.png': PNG,
  'Misc/old-site-backup.zip': writeZip([['index.html', '<html></html>']]),
}

function main(): void {
  fs.rmSync(OUT, { recursive: true, force: true })
  for (const [rel, data] of Object.entries(files)) {
    const abs = path.join(OUT, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, data)
  }
  console.log(`wrote ${Object.keys(files).length} files to ${OUT}`)
}

main()
