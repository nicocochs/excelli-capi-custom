/**
 * Build 3 Meta Custom Audience CSVs from GHL Excelli pipelines.
 *
 * Matches Meta's official "Customer File" template format (plain text — Meta
 * hashes server-side on upload). Headers per Meta's example file.
 *
 * Outputs:
 *   ./out/audiencia_leads.csv      — current stage = LEAD / LEAD VSL
 *                                    headers: email,phone,fn,ln,zip,ct,st,country
 *   ./out/audiencia_agendaron.csv  — current stage = AGENDADO
 *                                    headers: email,phone,fn,ln,zip,ct,st,country
 *   ./out/audiencia_compraron.csv  — current stage = COMPRO  [VALUE-BASED]
 *                                    headers: ...,uid,value  (enables Lookalike-by-value)
 *
 * Usage: npx tsx scripts/build-custom-audiences.ts
 */

import fs from 'fs'
import path from 'path'

const ENV_PATH = path.resolve('.env.local')
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) process.env[m[1]] ??= m[2].replace(/^"|"$/g, '')
  }
}

const LOCATION_ID = process.env.GHL_LOCATION_ID
const GHL_TOKEN   = process.env.GHL_API_KEY
if (!LOCATION_ID || !GHL_TOKEN) { console.error('Missing GHL_LOCATION_ID or GHL_API_KEY (set them in .env.local)'); process.exit(1) }
const OUT_DIR     = path.resolve('out')

type Bucket = 'leads' | 'agendaron' | 'compraron'

interface StageMap { pipelineName: string; pipelineId: string; stageName: string; stageId: string; bucket: Bucket }

const STAGES: StageMap[] = [
  { pipelineName: 'Pipeline IF + LANDING', pipelineId: '1BPLD96T7B1JkJKwuTxR', stageName: 'LEAD VSL',  stageId: '9d2b999e-d641-44ac-b8c8-4e266fd1e671', bucket: 'leads' },
  { pipelineName: 'Pipeline IF + LANDING', pipelineId: '1BPLD96T7B1JkJKwuTxR', stageName: 'AGENDADO',  stageId: 'b4c39d7a-208d-4e46-ad20-24507ed58530', bucket: 'agendaron' },
  { pipelineName: 'Pipeline IF + LANDING', pipelineId: '1BPLD96T7B1JkJKwuTxR', stageName: 'COMPRO',    stageId: '77127de3-d893-43d2-8fa1-c09f181ee111', bucket: 'compraron' },
  { pipelineName: 'landing + ia',          pipelineId: 'SPfuPCY2jJ3mFMY5jYGt', stageName: 'LEAD',      stageId: '56a5d405-aa2b-4439-bcd4-7fbd7ae68c8f', bucket: 'leads' },
  { pipelineName: 'landing + ia',          pipelineId: 'SPfuPCY2jJ3mFMY5jYGt', stageName: 'AGENDADO',  stageId: '46d01063-bac9-433e-91df-efdc6265dd41', bucket: 'agendaron' },
  { pipelineName: 'landing + ia',          pipelineId: 'SPfuPCY2jJ3mFMY5jYGt', stageName: 'COMPRO',    stageId: '9fcbd9c4-4093-4b45-aa4d-9bb6bdeacc5c', bucket: 'compraron' },
]

const ghlHeaders = {
  Authorization: `Bearer ${GHL_TOKEN}`,
  Version: '2021-07-28',
  Accept: 'application/json',
}

interface GhlContact { id: string; name?: string; email?: string; phone?: string }
interface GhlOpportunity { id: string; contactId: string; monetaryValue?: number; contact?: GhlContact }
interface OpportunityPage {
  opportunities: GhlOpportunity[]
  meta?: { startAfter?: number; startAfterId?: string }
}
interface ContactDetail { id: string; email?: string; phone?: string; firstName?: string; lastName?: string; city?: string; state?: string }

async function fetchOppsInStage(pipelineId: string, stageId: string): Promise<GhlOpportunity[]> {
  const out: GhlOpportunity[] = []
  let startAfter: number | undefined
  let startAfterId: string | undefined
  for (let page = 1; ; page++) {
    const qs = new URLSearchParams({ location_id: LOCATION_ID, pipeline_id: pipelineId, pipeline_stage_id: stageId, limit: '100' })
    if (startAfter)   qs.set('startAfter', String(startAfter))
    if (startAfterId) qs.set('startAfterId', startAfterId)
    const res = await fetch(`https://services.leadconnectorhq.com/opportunities/search?${qs}`, { headers: ghlHeaders })
    if (!res.ok) throw new Error(`GHL search failed ${res.status}: ${await res.text()}`)
    const json: OpportunityPage = await res.json()
    const batch = json.opportunities || []
    out.push(...batch)
    if (batch.length < 100 || !json.meta?.startAfter || !json.meta?.startAfterId) break
    startAfter = json.meta.startAfter
    startAfterId = json.meta.startAfterId
    if (page > 50) break
  }
  return out
}

async function fetchContact(contactId: string): Promise<ContactDetail | null> {
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: ghlHeaders })
  if (!res.ok) return null
  const json = await res.json() as { contact?: ContactDetail }
  return json.contact || null
}

// Match Meta's "Customer File" plain-text template (Meta hashes server-side).
// See: example_value_based_audience_file.csv shared by Meta.

interface Row {
  email: string
  phone: string
  fn: string
  ln: string
  zip: string
  ct: string
  st: string
  country: string
  // value-based only (compraron):
  uid?: string
  value?: string
}

function csvEscape(v: string): string {
  if (v === '' || v == null) return ''
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

function toRow(c: ContactDetail | null, fallback: GhlOpportunity, withValue: boolean): Row | null {
  const email = (c?.email || fallback.contact?.email || '').trim()
  const phone = (c?.phone || fallback.contact?.phone || '').trim()
  if (!email && !phone) return null
  const nameParts = (c?.firstName ? [c.firstName, c.lastName].filter(Boolean) : (fallback.contact?.name || '').split(' '))
  const firstName = (c?.firstName || nameParts[0] || '').trim()
  const lastName  = (c?.lastName  || nameParts.slice(1).join(' ') || '').trim()
  const row: Row = {
    email,
    phone,
    fn:      firstName,
    ln:      lastName,
    zip:     '',
    ct:      (c?.city  || '').trim(),
    st:      (c?.state || '').trim(),
    country: 'BR',
  }
  if (withValue) {
    row.uid   = fallback.id
    row.value = fallback.monetaryValue != null ? String(fallback.monetaryValue) : ''
  }
  return row
}

function writeCSV(filePath: string, rows: Row[], valueBased: boolean): void {
  const headers = valueBased
    ? ['email', 'phone', 'fn', 'ln', 'zip', 'ct', 'st', 'country', 'uid', 'value']
    : ['email', 'phone', 'fn', 'ln', 'zip', 'ct', 'st', 'country']
  const lines = [headers.join(',')]
  for (const r of rows) lines.push(headers.map(h => csvEscape(String(r[h as keyof Row] ?? ''))).join(','))
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })
  console.log(`\n${'═'.repeat(72)}\nMeta Custom Audience CSV builder — GHL Excelli\n${'═'.repeat(72)}`)

  // Highest-priority bucket wins per contactId (compraron > agendaron > leads).
  const BUCKET_RANK: Record<Bucket, number> = { leads: 1, agendaron: 2, compraron: 3 }
  const winningBucket = new Map<string, Bucket>()  // contactId → best bucket seen
  const oppByContact  = new Map<string, GhlOpportunity>()
  let totalOpps = 0

  for (const s of STAGES) {
    process.stdout.write(`▸ ${s.pipelineName} / ${s.stageName.padEnd(10)} `)
    const opps = await fetchOppsInStage(s.pipelineId, s.stageId)
    console.log(`opps=${String(opps.length).padStart(3)} → ${s.bucket}`)
    totalOpps += opps.length
    for (const opp of opps) {
      const prev = winningBucket.get(opp.contactId)
      if (!prev || BUCKET_RANK[s.bucket] > BUCKET_RANK[prev]) {
        winningBucket.set(opp.contactId, s.bucket)
        oppByContact.set(opp.contactId, opp)
      }
    }
  }

  const buckets: Record<Bucket, Map<string, Row>> = { leads: new Map(), agendaron: new Map(), compraron: new Map() }
  let skippedNoIdent = 0
  let enriched = 0
  for (const [contactId, bucket] of winningBucket) {
    const opp = oppByContact.get(contactId)!
    let detail: ContactDetail | null = null
    try { detail = await fetchContact(contactId) } catch { /* fallback */ }
    const row = toRow(detail, opp, bucket === 'compraron')
    if (!row) { skippedNoIdent++; continue }
    buckets[bucket].set(contactId, row)
    enriched++
    if (enriched % 25 === 0) process.stdout.write(`  · enriched ${enriched}/${winningBucket.size}\n`)
  }

  console.log(`\n${'─'.repeat(72)}`)
  for (const bucket of ['leads', 'agendaron', 'compraron'] as Bucket[]) {
    const filename = `audiencia_${bucket}.csv`
    const filePath = path.join(OUT_DIR, filename)
    const rows = Array.from(buckets[bucket].values())
    const valueBased = bucket === 'compraron'
    writeCSV(filePath, rows, valueBased)
    console.log(`✓ ${filename.padEnd(28)} ${String(rows.length).padStart(4)} rows  ${valueBased ? '[value-based]' : ''}  →  ${filePath}`)
  }
  console.log(`${'─'.repeat(72)}`)
  console.log(`opps scanned: ${totalOpps}   unique contacts: ${winningBucket.size}   no-email/no-phone: ${skippedNoIdent}   (highest-stage wins per contact)\n`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
