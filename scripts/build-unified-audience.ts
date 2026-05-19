/**
 * Build a single unified value-based Custom Audience CSV combining the 3 funnel stages.
 *
 * Output: out/audiencia_unified.csv  (headers: email,phone,fn,ln,zip,ct,st,country,uid,value)
 *
 * Logic:
 *   1. Gather opps from the 2 source pipelines (Pipeline IF + LANDING, landing + ia)
 *      across LEAD/AGENDADO/COMPRO stages — same as build-custom-audiences.ts.
 *   2. Cross-reference the Excel payments list (same as match-payments.ts) across
 *      ALL 4 pipelines, so paid customers in INSTANT FORM/CTW also get captured.
 *   3. Dedup by contactId. Highest funnel stage wins (compraron > agendaron > leads).
 *      A confirmed payer always wins over any earlier stage classification.
 *   4. Assign value:
 *        - lead       → 1   (form-fill only)
 *        - agendado   → 20  (attended/booked)
 *        - compraron  → real BRL value from Excel
 *
 * Usage: npx tsx scripts/build-unified-audience.ts
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

const VALUE_LEAD     = 1
const VALUE_AGENDADO = 20

type Bucket = 'leads' | 'agendaron' | 'compraron'
const BUCKET_RANK: Record<Bucket, number> = { leads: 1, agendaron: 2, compraron: 3 }

// Source pipelines for the base scan (LEAD/AGENDADO/COMPRO stages).
interface StageMap { pipelineName: string; pipelineId: string; stageName: string; stageId: string; bucket: Bucket }
const STAGES: StageMap[] = [
  { pipelineName: 'Pipeline IF + LANDING', pipelineId: '1BPLD96T7B1JkJKwuTxR', stageName: 'LEAD VSL', stageId: '9d2b999e-d641-44ac-b8c8-4e266fd1e671', bucket: 'leads' },
  { pipelineName: 'Pipeline IF + LANDING', pipelineId: '1BPLD96T7B1JkJKwuTxR', stageName: 'AGENDADO', stageId: 'b4c39d7a-208d-4e46-ad20-24507ed58530', bucket: 'agendaron' },
  { pipelineName: 'Pipeline IF + LANDING', pipelineId: '1BPLD96T7B1JkJKwuTxR', stageName: 'COMPRO',   stageId: '77127de3-d893-43d2-8fa1-c09f181ee111', bucket: 'compraron' },
  { pipelineName: 'landing + ia',          pipelineId: 'SPfuPCY2jJ3mFMY5jYGt', stageName: 'LEAD',     stageId: '56a5d405-aa2b-4439-bcd4-7fbd7ae68c8f', bucket: 'leads' },
  { pipelineName: 'landing + ia',          pipelineId: 'SPfuPCY2jJ3mFMY5jYGt', stageName: 'AGENDADO', stageId: '46d01063-bac9-433e-91df-efdc6265dd41', bucket: 'agendaron' },
  { pipelineName: 'landing + ia',          pipelineId: 'SPfuPCY2jJ3mFMY5jYGt', stageName: 'COMPRO',   stageId: '9fcbd9c4-4093-4b45-aa4d-9bb6bdeacc5c', bucket: 'compraron' },
]

// Excel payments (real BRL values).
const PAYMENTS: { name: string; value: number }[] = [
  { name: 'Ledson Inácios',      value: 4500  },
  { name: 'Jair Dourado',        value: 4700  },
  { name: 'Josefa Maria',        value: 500   },
  { name: 'Julio Cesar Machado', value: 12750 },
  { name: 'Evania Araujo',       value: 15800 },
  { name: 'JOsevan Alves',       value: 9000  },
  { name: 'Stefany Ferreira',    value: 300   },
  { name: 'Augusto',             value: 200   },
  { name: 'Samuel',              value: 200   },
  { name: 'Silvania nubia',      value: 7700  },
  { name: 'Ana Claudia',         value: 3500  },
]

type Override = { uid?: string; matchExactName?: string; preferStage?: string }
const OVERRIDES: Record<string, Override> = {
  'Evania Araujo':  { uid: 'GtkYy5R95pqtd6sdnGEK' },
  'JOsevan Alves':  { matchExactName: 'Josivan Alves' },
  'Augusto':        { matchExactName: 'Augustus Antunes', preferStage: 'COMPRÓ' },
  'Samuel':         { matchExactName: 'Samuel Alves Souza' },
}

// ── GHL helpers (identical contract to other scripts) ───────────────────────
const ghlHeaders = { Authorization: `Bearer ${GHL_TOKEN}`, Version: '2021-07-28', Accept: 'application/json' }

interface GhlContact { id: string; name?: string; email?: string; phone?: string }
interface GhlOpportunity { id: string; contactId: string; pipelineId: string; pipelineStageId: string; monetaryValue?: number; contact?: GhlContact }
interface OpportunityPage { opportunities: GhlOpportunity[]; meta?: { startAfter?: number; startAfterId?: string } }
interface ContactDetail { id: string; email?: string; phone?: string; firstName?: string; lastName?: string; city?: string; state?: string }
interface PipelineInfo { id: string; name: string; stages: { id: string; name: string }[] }

async function listPipelines(): Promise<PipelineInfo[]> {
  const res = await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${LOCATION_ID}`, { headers: ghlHeaders })
  if (!res.ok) throw new Error(`pipelines failed ${res.status}`)
  const json = await res.json() as { pipelines: PipelineInfo[] }
  return json.pipelines
}

async function fetchPaged(qsBase: Record<string, string>): Promise<GhlOpportunity[]> {
  const out: GhlOpportunity[] = []
  let startAfter: number | undefined
  let startAfterId: string | undefined
  for (let page = 1; ; page++) {
    const qs = new URLSearchParams({ ...qsBase, limit: '100' })
    if (startAfter)   qs.set('startAfter', String(startAfter))
    if (startAfterId) qs.set('startAfterId', startAfterId)
    const res = await fetch(`https://services.leadconnectorhq.com/opportunities/search?${qs}`, { headers: ghlHeaders })
    if (!res.ok) throw new Error(`search failed ${res.status}: ${await res.text()}`)
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

// ── Name matching (copied verbatim from match-payments.ts) ──────────────────
function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}
function tokens(s: string): string[] { return normalize(s).split(' ').filter(t => t.length >= 2) }
function lev(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length, n = b.length
  if (!m) return n; if (!n) return m
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const c = a[i-1] === b[j-1] ? 0 : 1
    dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+c)
  }
  return dp[m][n]
}
function tokenMatches(t: string, hay: string[]): boolean {
  for (const ht of hay) {
    if (ht === t) return true
    if (t.length >= 4 && ht.length >= 4 && (ht.startsWith(t) || t.startsWith(ht))) return true
    if (t.length >= 5 && ht.length >= 5 && Math.abs(t.length - ht.length) <= 2 && lev(t, ht) <= 2) return true
  }
  return false
}
function nameMatch(needle: string, hay: string): boolean {
  const n = tokens(needle), h = tokens(hay)
  if (!n.length || !h.length) return false
  if (n.length === 1) return tokenMatches(n[0], [h[0]])
  return n.every(t => tokenMatches(t, h))
}

// ── CSV ─────────────────────────────────────────────────────────────────────
function csvEscape(v: string): string {
  if (v === '' || v == null) return ''
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

interface Row { email: string; phone: string; fn: string; ln: string; zip: string; ct: string; st: string; country: string; uid: string; value: string }

function rowFor(opp: GhlOpportunity, detail: ContactDetail | null, value: number): Row | null {
  const email = (detail?.email || opp.contact?.email || '').trim()
  const phone = (detail?.phone || opp.contact?.phone || '').trim()
  if (!email && !phone) return null
  const nameParts = detail?.firstName ? [detail.firstName, detail.lastName].filter(Boolean) : (opp.contact?.name || '').split(' ')
  return {
    email, phone,
    fn:      (detail?.firstName || nameParts[0] || '').trim(),
    ln:      (detail?.lastName  || nameParts.slice(1).join(' ') || '').trim(),
    zip:     '',
    ct:      (detail?.city  || '').trim(),
    st:      (detail?.state || '').trim(),
    country: 'BR',
    uid:     opp.id,
    value:   String(value),
  }
}

function writeCSV(filePath: string, rows: Row[]): void {
  const headers = ['email', 'phone', 'fn', 'ln', 'zip', 'ct', 'st', 'country', 'uid', 'value']
  const lines = [headers.join(',')]
  for (const r of rows) lines.push(headers.map(h => csvEscape(String(r[h as keyof Row] ?? ''))).join(','))
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'═'.repeat(78)}`)
  console.log(`Unified value-based Custom Audience builder`)
  console.log('═'.repeat(78))

  // Step 1 — base scan: opps from the 2 source pipelines in LEAD/AGENDADO/COMPRO stages.
  type Bag = { opp: GhlOpportunity; bucket: Bucket; pipelineName: string; stageName: string }
  const buckByContact = new Map<string, Bag>()
  for (const s of STAGES) {
    process.stdout.write(`▸ ${s.pipelineName} / ${s.stageName.padEnd(10)} `)
    const opps = await fetchPaged({ location_id: LOCATION_ID, pipeline_id: s.pipelineId, pipeline_stage_id: s.stageId })
    console.log(`opps=${String(opps.length).padStart(3)} → ${s.bucket}`)
    for (const opp of opps) {
      const prev = buckByContact.get(opp.contactId)
      if (!prev || BUCKET_RANK[s.bucket] > BUCKET_RANK[prev.bucket]) {
        buckByContact.set(opp.contactId, { opp, bucket: s.bucket, pipelineName: s.pipelineName, stageName: s.stageName })
      }
    }
  }
  console.log(`Base contacts gathered: ${buckByContact.size}\n`)

  // Step 2 — cross-reference Excel payments across ALL pipelines (to catch Augustus in INSTANT FORM etc.).
  const pipelines = await listPipelines()
  const allOpps: { opp: GhlOpportunity; pipelineName: string; stageName: string }[] = []
  for (const p of pipelines) {
    const opps = await fetchPaged({ location_id: LOCATION_ID, pipeline_id: p.id })
    const stageById = new Map(p.stages.map(s => [s.id, s.name]))
    for (const opp of opps) allOpps.push({ opp, pipelineName: p.name, stageName: stageById.get(opp.pipelineStageId) || '?' })
  }
  console.log(`Total opps across all pipelines (for payment cross-ref): ${allOpps.length}`)

  // Apply Excel payments → upgrade matched contacts to 'compraron' with real value.
  const paymentByContactId = new Map<string, number>()
  let paymentMatched = 0, paymentMissed = 0
  for (const payment of PAYMENTS) {
    const ov = OVERRIDES[payment.name]
    let target: typeof allOpps[number] | undefined
    if (ov?.uid)                    target = allOpps.find(o => o.opp.id === ov.uid)
    else if (ov?.matchExactName) {
      const want = normalize(ov.matchExactName)
      const cands = allOpps.filter(o => normalize(o.opp.contact?.name || '') === want)
      target = ov.preferStage ? (cands.find(c => c.stageName.toUpperCase() === ov.preferStage!.toUpperCase()) || cands[0]) : cands[0]
    } else {
      const cands = allOpps.filter(o => o.opp.contact?.name && nameMatch(payment.name, o.opp.contact.name))
      if (cands.length === 1) target = cands[0]
    }
    if (target) {
      paymentByContactId.set(target.opp.contactId, payment.value)
      // If this paid contact isn't already in the base scan (e.g. lives in INSTANT FORM), add them.
      const prev = buckByContact.get(target.opp.contactId)
      if (!prev || BUCKET_RANK.compraron > BUCKET_RANK[prev.bucket]) {
        buckByContact.set(target.opp.contactId, { opp: target.opp, bucket: 'compraron', pipelineName: target.pipelineName, stageName: target.stageName })
      }
      paymentMatched++
    } else {
      paymentMissed++
      console.log(`  ⚠ payment "${payment.name}" R$ ${payment.value} → no match`)
    }
  }
  console.log(`Payments matched: ${paymentMatched}/${PAYMENTS.length}  (missed: ${paymentMissed})\n`)

  // Step 3 — enrich each contact and assign value per bucket.
  const rows: Row[] = []
  let skippedNoIdent = 0
  let n = 0
  for (const [contactId, bag] of buckByContact) {
    n++
    let detail: ContactDetail | null = null
    try { detail = await fetchContact(contactId) } catch { /* fallback */ }
    let value: number
    if (bag.bucket === 'compraron') {
      value = paymentByContactId.get(contactId) ?? 0   // 0 means "in COMPRO but no Excel match" — shouldn't happen here
    } else if (bag.bucket === 'agendaron') {
      value = VALUE_AGENDADO
    } else {
      value = VALUE_LEAD
    }
    const row = rowFor(bag.opp, detail, value)
    if (!row) { skippedNoIdent++; continue }
    rows.push(row)
    if (n % 25 === 0) process.stdout.write(`  · enriched ${n}/${buckByContact.size}\n`)
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })
  const target = path.join(OUT_DIR, 'audiencia_unified.csv')
  writeCSV(target, rows)

  // Summary
  const byBucketCount = { leads: 0, agendaron: 0, compraron: 0 } as Record<Bucket, number>
  const byBucketValue = { leads: 0, agendaron: 0, compraron: 0 } as Record<Bucket, number>
  for (const [, bag] of buckByContact) byBucketCount[bag.bucket]++
  for (const r of rows) {
    if (r.value === '1')         byBucketValue.leads     += 1
    else if (r.value === '20')   byBucketValue.agendaron += 20
    else                          byBucketValue.compraron += Number(r.value)
  }
  console.log(`\n${'─'.repeat(78)}`)
  console.log(`✓ Wrote ${rows.length} rows to ${target}`)
  console.log(`  leads     ${String(byBucketCount.leads    ).padStart(3)} × value=1     = R$ ${byBucketValue.leads}`)
  console.log(`  agendaron ${String(byBucketCount.agendaron).padStart(3)} × value=20    = R$ ${byBucketValue.agendaron}`)
  console.log(`  compraron ${String(byBucketCount.compraron).padStart(3)} × value=real  = R$ ${byBucketValue.compraron}`)
  console.log(`  skipped (no email/phone): ${skippedNoIdent}`)
  console.log('─'.repeat(78))
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
