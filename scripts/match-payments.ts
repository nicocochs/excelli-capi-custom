/**
 * Match a known list of paid customers (from Excel) against ALL GHL opps
 * across ALL pipelines/stages, then rewrite audiencia_compraron.csv with
 * each contact's real BRL value (instead of monetaryValue=0).
 *
 * Strategy:
 *  1. Fetch every opportunity from every pipeline in the location.
 *  2. Normalize contact names (lowercase, strip accents, remove punctuation).
 *  3. For each known payment, find best-effort matches against opps.
 *  4. Print a match report; on confirmation rewrite out/audiencia_compraron.csv
 *     with header email,phone,fn,ln,zip,ct,st,country,uid,value.
 *
 * Usage:
 *   npx tsx scripts/match-payments.ts             # dry-run, just report matches
 *   npx tsx scripts/match-payments.ts --write     # rewrite compraron.csv
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
const WRITE       = process.argv.includes('--write')

// ── Known payments (from the user's Excel) ──────────────────────────────────
// Names exactly as in the Excel (with any typos/case). The matcher normalizes.
const PAYMENTS: { name: string; value: number; date: string }[] = [
  { name: 'Ledson Inácios',       value: 4500,  date: '08-dic' },
  { name: 'Jair Dourado',         value: 4700,  date: '14-ene' },
  { name: 'Josefa Maria',         value: 500,   date: '19-ene' },
  { name: 'Julio Cesar Machado',  value: 12750, date: '21-ene' },
  { name: 'Evania Araujo',        value: 15800, date: '26-ene' },
  { name: 'JOsevan Alves',        value: 9000,  date: '26-ene' },
  { name: 'Stefany Ferreira',     value: 300,   date: '09-ene' },
  { name: 'Augusto',              value: 200,   date: '28-abr' },
  { name: 'Samuel',               value: 200,   date: '14-abr' },
  { name: 'Silvania nubia',       value: 7700,  date: '23-feb' },
  { name: 'Ana Claudia',          value: 3500,  date: '11-may' },
]

// ── GHL fetchers ────────────────────────────────────────────────────────────
const ghlHeaders = {
  Authorization: `Bearer ${GHL_TOKEN}`,
  Version: '2021-07-28',
  Accept: 'application/json',
}

interface GhlContact { id: string; name?: string; email?: string; phone?: string }
interface GhlOpportunity {
  id: string; contactId: string; pipelineId: string; pipelineStageId: string
  monetaryValue?: number; contact?: GhlContact
}
interface OpportunityPage {
  opportunities: GhlOpportunity[]
  meta?: { startAfter?: number; startAfterId?: string }
}
interface ContactDetail { id: string; email?: string; phone?: string; firstName?: string; lastName?: string; city?: string; state?: string }
interface PipelineInfo { id: string; name: string; stages: { id: string; name: string }[] }

async function listPipelines(): Promise<PipelineInfo[]> {
  const res = await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${LOCATION_ID}`, { headers: ghlHeaders })
  if (!res.ok) throw new Error(`pipelines failed ${res.status}: ${await res.text()}`)
  const json = await res.json() as { pipelines: PipelineInfo[] }
  return json.pipelines
}

async function fetchAllOppsInPipeline(pipelineId: string): Promise<GhlOpportunity[]> {
  const out: GhlOpportunity[] = []
  let startAfter: number | undefined
  let startAfterId: string | undefined
  for (let page = 1; ; page++) {
    const qs = new URLSearchParams({ location_id: LOCATION_ID, pipeline_id: pipelineId, limit: '100' })
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

// ── Manual overrides (user-confirmed matches that fuzzy matcher gets wrong) ─
type Override = { uid?: string; matchExactName?: string; preferStage?: string }
const OVERRIDES: Record<string, Override> = {
  'Evania Araujo':  { uid: 'GtkYy5R95pqtd6sdnGEK' },               // Evania Araujo === Evania Santos
  'JOsevan Alves':  { matchExactName: 'Josivan Alves' },           // Excel typo
  'Augusto':        { matchExactName: 'Augustus Antunes', preferStage: 'COMPRÓ' },
  'Samuel':         { matchExactName: 'Samuel Alves Souza' },
}

// ── Name matching ───────────────────────────────────────────────────────────
function normalize(s: string): string {
  return s
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')   // strip combining diacritics (Unicode property)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokens(s: string): string[] {
  return normalize(s).split(' ').filter(t => t.length >= 2)
}

// Levenshtein distance — small token compare for typos like "josevan" vs "josivan".
function lev(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

function tokenMatches(needleTok: string, hayTokens: string[]): { ok: boolean; how: string } {
  for (const ht of hayTokens) {
    if (ht === needleTok) return { ok: true, how: 'exact' }
    // Prefix match for plural/stem: "inacios" vs "inacio" or vice-versa.
    if (needleTok.length >= 4 && ht.length >= 4 && (ht.startsWith(needleTok) || needleTok.startsWith(ht))) {
      return { ok: true, how: `prefix(${needleTok}~${ht})` }
    }
    // Levenshtein ≤ 2 for tokens ≥ 5 chars (catches "josevan"~"josivan", typos).
    if (needleTok.length >= 5 && ht.length >= 5 && Math.abs(needleTok.length - ht.length) <= 2) {
      if (lev(needleTok, ht) <= 2) return { ok: true, how: `lev≤2(${needleTok}~${ht})` }
    }
  }
  return { ok: false, how: '' }
}

function nameMatch(needle: string, hay: string): { ok: boolean; reason: string } {
  const n = tokens(needle)
  const h = tokens(hay)
  if (n.length === 0 || h.length === 0) return { ok: false, reason: 'empty' }

  // Single-token needle (e.g. "Augusto") — must match the FIRST name (hay[0]) only,
  // not a middle/last name, to avoid false positives like "Marta Maria Augusto".
  if (n.length === 1) {
    const m = tokenMatches(n[0], [h[0]])
    return m.ok ? { ok: true, reason: `single-token first-name ${m.how}` } : { ok: false, reason: `single-token "${n[0]}" ≠ first name "${h[0]}"` }
  }

  // Multi-token: every needle token must match some hay token (exact / prefix / lev≤2).
  const used: string[] = []
  for (const t of n) {
    const m = tokenMatches(t, h)
    if (!m.ok) return { ok: false, reason: `no match for "${t}"` }
    used.push(m.how)
  }
  return { ok: true, reason: used.join('+') }
}

// ── CSV writer ──────────────────────────────────────────────────────────────
function csvEscape(v: string): string {
  if (v === '' || v == null) return ''
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

interface Row {
  email: string; phone: string; fn: string; ln: string
  zip: string; ct: string; st: string; country: string
  uid: string; value: string
}

function rowFor(opp: GhlOpportunity, detail: ContactDetail | null, value: number): Row | null {
  const email = (detail?.email || opp.contact?.email || '').trim()
  const phone = (detail?.phone || opp.contact?.phone || '').trim()
  if (!email && !phone) return null
  const nameParts = (detail?.firstName ? [detail.firstName, detail.lastName].filter(Boolean) : (opp.contact?.name || '').split(' '))
  return {
    email,
    phone,
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
  console.log(`GHL × Excel payments matcher  ${WRITE ? '[WRITE]' : '[DRY-RUN — pass --write to save CSV]'}`)
  console.log('═'.repeat(78))

  const pipelines = await listPipelines()
  console.log(`Pipelines in location: ${pipelines.length}`)

  // Pull all opps across pipelines.
  const allOpps: { opp: GhlOpportunity; pipelineName: string; stageName: string }[] = []
  for (const p of pipelines) {
    process.stdout.write(`  ▸ ${p.name.padEnd(28)} `)
    const opps = await fetchAllOppsInPipeline(p.id)
    const stageById = new Map(p.stages.map(s => [s.id, s.name]))
    for (const opp of opps) allOpps.push({ opp, pipelineName: p.name, stageName: stageById.get(opp.pipelineStageId) || '?' })
    console.log(`opps=${opps.length}`)
  }
  console.log(`Total opps scanned: ${allOpps.length}\n`)

  // Match each payment.
  type Hit = { opp: GhlOpportunity; pipelineName: string; stageName: string; reason: string }
  const report: { payment: typeof PAYMENTS[number]; hits: Hit[] }[] = []
  const oppById = new Map(allOpps.map(o => [o.opp.id, o]))
  for (const payment of PAYMENTS) {
    const override = OVERRIDES[payment.name]
    if (override) {
      if (override.uid) {
        const found = oppById.get(override.uid)
        if (found) { report.push({ payment, hits: [{ opp: found.opp, pipelineName: found.pipelineName, stageName: found.stageName, reason: `OVERRIDE uid=${override.uid}` }] }); continue }
        console.warn(`  ⚠ override uid ${override.uid} not found for "${payment.name}"`)
        report.push({ payment, hits: [] })
        continue
      }
      if (override.matchExactName) {
        const target = normalize(override.matchExactName)
        const matches = allOpps.filter(o => normalize(o.opp.contact?.name || '') === target)
        const preferred = override.preferStage
          ? matches.find(m => m.stageName.toUpperCase() === override.preferStage!.toUpperCase()) || matches[0]
          : matches[0]
        if (preferred) {
          report.push({ payment, hits: [{ opp: preferred.opp, pipelineName: preferred.pipelineName, stageName: preferred.stageName, reason: `OVERRIDE name="${override.matchExactName}"${override.preferStage ? `, stage=${override.preferStage}` : ''}` }] })
        } else {
          console.warn(`  ⚠ override name "${override.matchExactName}" not found for "${payment.name}"`)
          report.push({ payment, hits: [] })
        }
        continue
      }
    }
    const hits: Hit[] = []
    for (const { opp, pipelineName, stageName } of allOpps) {
      const oppName = opp.contact?.name || ''
      if (!oppName) continue
      const m = nameMatch(payment.name, oppName)
      if (m.ok) hits.push({ opp, pipelineName, stageName, reason: m.reason })
    }
    report.push({ payment, hits })
  }

  // Print report.
  console.log('Match report:')
  console.log('─'.repeat(78))
  for (const r of report) {
    const tag = `${r.payment.name.padEnd(22)} R$ ${String(r.payment.value).padStart(6)}`
    if (r.hits.length === 0) {
      console.log(`  ✗ ${tag}   NO MATCH`)
    } else if (r.hits.length === 1) {
      const h = r.hits[0]
      console.log(`  ✓ ${tag}   → ${(h.opp.contact?.name || '').padEnd(28)} [${h.pipelineName} / ${h.stageName}] (${h.reason})`)
    } else {
      console.log(`  ⚠ ${tag}   ${r.hits.length} MATCHES:`)
      for (const h of r.hits) console.log(`        - ${(h.opp.contact?.name || '').padEnd(28)} [${h.pipelineName} / ${h.stageName}] (${h.reason})`)
    }
  }
  console.log('─'.repeat(78))

  // Build chosen rows: 1-hit auto-included, multi-hit excluded (needs human disambig).
  type Chosen = { opp: GhlOpportunity; value: number }
  const chosen: Chosen[] = []
  const ambiguous: typeof report = []
  const noMatch:   typeof report = []
  for (const r of report) {
    if (r.hits.length === 1) chosen.push({ opp: r.hits[0].opp, value: r.payment.value })
    else if (r.hits.length === 0) noMatch.push(r)
    else ambiguous.push(r)
  }
  console.log(`\nSummary: ${chosen.length} unique match | ${ambiguous.length} ambiguous (skipped) | ${noMatch.length} no match`)

  if (!WRITE) {
    console.log('\nDry-run only. Re-run with --write to rewrite out/audiencia_compraron.csv.\n')
    return
  }

  // Enrich + write.
  console.log('\nFetching contact details for chosen opps...')
  const rows: Row[] = []
  for (const c of chosen) {
    let detail: ContactDetail | null = null
    try { detail = await fetchContact(c.opp.contactId) } catch { /* fallback */ }
    const row = rowFor(c.opp, detail, c.value)
    if (row) rows.push(row)
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })
  const target = path.join(OUT_DIR, 'audiencia_compraron.csv')
  writeCSV(target, rows)
  console.log(`\n✓ Wrote ${rows.length} rows to ${target}\n`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
