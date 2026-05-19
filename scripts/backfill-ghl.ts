/**
 * Backfill GHL Excelli opportunities into Meta CAPI for audience modeling.
 *
 * Mapping (per stage AT THE CURRENT TIME):
 *   - "lead"      stage → consulta_solicitada @ opp.createdAt
 *   - "confirmed" stage → consulta_solicitada @ opp.createdAt + servicio_confirmado @ opp.updatedAt
 *   - "closed"    stage → consulta_solicitada @ opp.createdAt + servicio_confirmado @ midpoint + servicio_cerrado @ opp.updatedAt
 *
 * Usage:
 *   npx tsx scripts/backfill-ghl.ts --dry-run     # count only, send nothing
 *   npx tsx scripts/backfill-ghl.ts --pipeline=if # process only one pipeline
 *   npx tsx scripts/backfill-ghl.ts               # SEND FOR REAL
 *
 * Required env (read from .env.local or shell):
 *   GHL_LOCATION_ID, GHL_API_KEY, CAPI_ENDPOINT (defaults to prod)
 */

import fs from 'fs'
import path from 'path'

// ── Config ───────────────────────────────────────────────────────────────────
const ENV_PATH = path.resolve('.env.local')
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) process.env[m[1]] ??= m[2].replace(/^"|"$/g, '')
  }
}

const LOCATION_ID = process.env.GHL_LOCATION_ID || 'BnzFuaPdm0o7YAbKDL3t'
const GHL_TOKEN   = process.env.GHL_API_KEY     || 'pit-f88ca86e-4c8a-45d3-b7c7-0439957a6d3c'
const CAPI_URL    = process.env.CAPI_ENDPOINT   || 'https://excelli-capi-custom.vercel.app/api/event'
const DELAY_MS    = Number(process.env.DELAY_MS || 250)

const DRY_RUN  = process.argv.includes('--dry-run')
const ONLY_PIP = (process.argv.find(a => a.startsWith('--pipeline=')) || '').split('=')[1] || ''

// Meta CAPI rejects event_time older than 7 days (error 2804003). Use 6 days for safety margin.
const WINDOW_DAYS = 6
const CUTOFF_SEC  = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 24 * 3600

type Mode = 'lead' | 'confirmed' | 'closed'
type Stage = { id: string; name: string; mode: Mode }
type Pipeline = { key: string; name: string; pipelineId: string; stages: Stage[] }

const PIPELINES: Pipeline[] = [
  {
    key: 'if',
    name: 'Pipeline IF + LANDING',
    pipelineId: '1BPLD96T7B1JkJKwuTxR',
    stages: [
      { id: '9d2b999e-d641-44ac-b8c8-4e266fd1e671', name: 'LEAD VSL',  mode: 'lead' },
      { id: 'b4c39d7a-208d-4e46-ad20-24507ed58530', name: 'AGENDADO',  mode: 'confirmed' },
      { id: '77127de3-d893-43d2-8fa1-c09f181ee111', name: 'COMPRO',    mode: 'closed' },
    ],
  },
  {
    key: 'ia',
    name: 'landing + ia',
    pipelineId: 'SPfuPCY2jJ3mFMY5jYGt',
    stages: [
      { id: '56a5d405-aa2b-4439-bcd4-7fbd7ae68c8f', name: 'LEAD',     mode: 'lead' },
      { id: '46d01063-bac9-433e-91df-efdc6265dd41', name: 'AGENDADO', mode: 'confirmed' },
      { id: '9fcbd9c4-4093-4b45-aa4d-9bb6bdeacc5c', name: 'COMPRO',   mode: 'closed' },
    ],
  },
]

// ── Types ────────────────────────────────────────────────────────────────────
interface GhlContact {
  id: string
  name?: string
  companyName?: string
  email?: string
  phone?: string
  tags?: string[]
}

interface GhlOpportunity {
  id: string
  name?: string
  monetaryValue?: number
  pipelineId: string
  pipelineStageId: string
  status?: string
  source?: string
  contactId: string
  contact?: GhlContact
  createdAt: string
  updatedAt: string
}

interface OpportunityPage {
  opportunities: GhlOpportunity[]
  meta?: { total?: number; nextPageUrl?: string; startAfter?: number; startAfterId?: string }
}

interface ContactDetail {
  id: string
  email?: string
  phone?: string
  firstName?: string
  lastName?: string
  city?: string
  state?: string
}

// ── GHL helpers ──────────────────────────────────────────────────────────────
const ghlHeaders = {
  Authorization: `Bearer ${GHL_TOKEN}`,
  Version: '2021-07-28',
  Accept: 'application/json',
}

async function fetchOpportunitiesInStage(pipelineId: string, stageId: string): Promise<GhlOpportunity[]> {
  const out: GhlOpportunity[] = []
  let startAfter: number | undefined
  let startAfterId: string | undefined
  for (let page = 1; ; page++) {
    const qs = new URLSearchParams({
      location_id: LOCATION_ID,
      pipeline_id: pipelineId,
      pipeline_stage_id: stageId,
      limit: '100',
    })
    if (startAfter)   qs.set('startAfter', String(startAfter))
    if (startAfterId) qs.set('startAfterId', startAfterId)

    const res = await fetch(`https://services.leadconnectorhq.com/opportunities/search?${qs}`, { headers: ghlHeaders })
    if (!res.ok) {
      throw new Error(`GHL search failed (${res.status}): ${await res.text()}`)
    }
    const json: OpportunityPage = await res.json()
    const batch = json.opportunities || []
    out.push(...batch)
    if (batch.length < 100 || !json.meta?.startAfter || !json.meta?.startAfterId) break
    startAfter = json.meta.startAfter
    startAfterId = json.meta.startAfterId
    if (page > 50) { console.warn('  ⚠ pagination cap hit (50 pages = 5000 rows)'); break }
  }
  return out
}

async function fetchContactDetail(contactId: string): Promise<ContactDetail | null> {
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: ghlHeaders })
  if (!res.ok) return null
  const json = await res.json() as { contact?: ContactDetail }
  return json.contact || null
}

// ── Event builder ────────────────────────────────────────────────────────────
interface CapiPayload {
  email?: string
  phone?: string
  firstName?: string
  lastName?: string
  city?: string
  state?: string
  eventName: 'consulta_solicitada' | 'servicio_confirmado' | 'servicio_cerrado'
  eventId: string
  event_time: number
  skipStandard: true
  value?: string
  currency?: string
}

function buildEventsForOpp(opp: GhlOpportunity, mode: Mode, contact: ContactDetail | null): CapiPayload[] {
  const createdSec = Math.floor(new Date(opp.createdAt).getTime() / 1000)
  const updatedSec = Math.floor(new Date(opp.updatedAt).getTime() / 1000)
  // For "closed", interpolate confirmation as midpoint (no per-stage timestamp in GHL standard API).
  const midSec = createdSec + Math.floor((updatedSec - createdSec) / 2)

  const base = {
    email:     contact?.email     || opp.contact?.email,
    phone:     contact?.phone     || opp.contact?.phone,
    firstName: contact?.firstName || opp.contact?.name?.split(' ')[0],
    lastName:  contact?.lastName  || opp.contact?.name?.split(' ').slice(1).join(' ') || undefined,
    city:      contact?.city,
    state:     contact?.state,
    skipStandard: true as const,
  }

  const events: CapiPayload[] = []
  events.push({ ...base, eventName: 'consulta_solicitada', eventId: `hist_${opp.id}_lead`, event_time: createdSec })

  if (mode === 'confirmed' || mode === 'closed') {
    events.push({
      ...base,
      eventName: 'servicio_confirmado',
      eventId: `hist_${opp.id}_conf`,
      event_time: mode === 'confirmed' ? updatedSec : midSec,
    })
  }
  if (mode === 'closed') {
    events.push({
      ...base,
      eventName: 'servicio_cerrado',
      eventId: `hist_${opp.id}_close`,
      event_time: updatedSec,
      ...(opp.monetaryValue ? { value: String(opp.monetaryValue), currency: 'BRL' } : {}),
    })
  }

  // Meta CAPI rejects events older than 7 days. Drop anything outside the window.
  return events.filter(ev => ev.event_time >= CUTOFF_SEC)
}

// ── Main ─────────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log(`\n${'═'.repeat(72)}`)
  console.log(`GHL → Meta CAPI backfill   ${DRY_RUN ? '[DRY RUN]' : '[LIVE — sending events]'}`)
  console.log(`Location: ${LOCATION_ID}`)
  console.log(`Endpoint: ${CAPI_URL}`)
  console.log(`Window:   last ${WINDOW_DAYS} days (event_time >= ${new Date(CUTOFF_SEC * 1000).toISOString()})`)
  if (ONLY_PIP) console.log(`Filter:   pipeline=${ONLY_PIP}`)
  console.log('═'.repeat(72))

  const pipelines = ONLY_PIP ? PIPELINES.filter(p => p.key === ONLY_PIP) : PIPELINES
  if (pipelines.length === 0) { console.error(`No pipeline matched key="${ONLY_PIP}"`); process.exit(1) }

  // Phase 1 — gather, then filter to in-window events only
  type Plan = { opp: GhlOpportunity; mode: Mode; pipelineName: string; stageName: string; events: CapiPayload[] }
  const allPlans: Plan[] = []
  for (const p of pipelines) {
    console.log(`\n▸ ${p.name}`)
    for (const s of p.stages) {
      const opps = await fetchOpportunitiesInStage(p.pipelineId, s.id)
      let inWindow = 0
      for (const opp of opps) {
        const events = buildEventsForOpp(opp, s.mode, null)  // no contact detail yet → only filter by time
        if (events.length === 0) continue
        inWindow++
        allPlans.push({ opp, mode: s.mode, pipelineName: p.name, stageName: s.name, events })
      }
      console.log(`   - ${s.name.padEnd(12)} total: ${String(opps.length).padStart(4)}   in-window: ${String(inWindow).padStart(4)} → ${s.mode}`)
    }
  }

  const eventsToSend = allPlans.reduce((n, p) => n + p.events.length, 0)
  console.log(`\n${'─'.repeat(72)}`)
  console.log(`Opportunities in 7-day window: ${allPlans.length}`)
  console.log(`Total CAPI events to send:     ${eventsToSend}`)
  console.log('─'.repeat(72))

  if (DRY_RUN) {
    console.log('\nDRY RUN — no events sent. Re-run without --dry-run to send.\n')
    return
  }

  // Phase 2 — enrich with contact detail and send
  let ok = 0, fail = 0, skipped = 0
  for (const [i, plan] of allPlans.entries()) {
    const { opp, mode, pipelineName, stageName } = plan
    const tag = `[${String(i + 1).padStart(4)}/${allPlans.length}] ${pipelineName.slice(0, 18).padEnd(18)} ${stageName.padEnd(10)}`

    const baseEmail = opp.contact?.email
    const basePhone = opp.contact?.phone
    if (!baseEmail && !basePhone) {
      console.log(`${tag} ${opp.id}  ⊘ no email/phone — skipped`)
      skipped++
      continue
    }

    let contact: ContactDetail | null = null
    try { contact = await fetchContactDetail(opp.contactId) } catch { /* fallthrough — use opp.contact */ }

    // Re-build with enriched contact (still time-filtered) and send.
    const events = buildEventsForOpp(opp, mode, contact)
    for (const ev of events) {
      try {
        const res = await fetch(CAPI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ev),
        })
        const data = await res.json() as { events_received?: number; error?: unknown; messages?: unknown }
        if (data.events_received === 1) { ok++ }
        else { fail++; console.log(`${tag} ${ev.eventName.padEnd(22)} ✗ ${JSON.stringify(data)}`) }
      } catch (err) {
        fail++
        console.log(`${tag} ${ev.eventName.padEnd(22)} ✗ ${err}`)
      }
      await sleep(DELAY_MS)
    }

    if ((i + 1) % 25 === 0) {
      console.log(`${tag} … running totals: ok=${ok} fail=${fail} skipped=${skipped}`)
    }
  }

  console.log(`\n${'═'.repeat(72)}`)
  console.log(`Done. ok=${ok}  fail=${fail}  skipped=${skipped}  (of ${eventsToSend} planned events)`)
  console.log('═'.repeat(72))
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
