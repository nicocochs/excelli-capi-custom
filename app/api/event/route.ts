import { createHash } from 'crypto'

const PIXEL_ID = process.env.PIXEL_ID!
const CAPI_TOKEN = process.env.CAPI_TOKEN!
const CAPI_URL = `https://graph.facebook.com/v18.0/${PIXEL_ID}/events`

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function hash(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex')
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const cd = body.customData || {}

    const email     = body.email     || cd.email
    const phone     = body.phone     || cd.phone
    const firstName = body.firstName || cd.firstName
    const lastName  = body.lastName  || cd.lastName
    const city      = body.city      || cd.city
    const state     = body.state     || cd.state
    const eventName = body.eventName || cd.eventName || 'consulta_solicitada'
    const eventId   = body.eventId   || cd.eventId
    const pageUrl   = body.pageUrl   || cd.pageUrl   || 'https://momentodemudanca.com'
    const value     = body.value     || cd.value
    const currency  = body.currency  || cd.currency
    const testCode        = body.testCode        || cd.testCode
    const fbp             = body.fbp             || cd.fbp
    const fbc             = body.fbc             || cd.fbc
    const clientIp        = body.clientIp        || cd.clientIp
    const clientUserAgent = body.clientUserAgent || cd.clientUserAgent
    const eventTimeIn     = body.event_time      ?? cd.event_time

    console.log('[capi-request]', {
      eventName,
      email: email ? 'present' : 'missing',
      fbc: fbc ? 'present' : 'missing',
      fbp: fbp ? 'present' : 'missing',
      eventId: eventId ? 'present' : 'missing',
      source: body.eventName ? 'root' : 'customData',
    })

    const user_data = {
      em: email ? [hash(email)] : [],
      ph: phone ? [hash(phone.replace(/\D/g, ''))] : [],
      fn: firstName ? [hash(firstName)] : [],
      ln: lastName ? [hash(lastName)] : [],
      ct: city ? [hash(city)] : [],
      st: state ? [hash(state)] : [],
      country: [hash('br')],
      client_ip_address: clientIp || undefined,
      client_user_agent: clientUserAgent || undefined,
      fbc: fbc || undefined,
      fbp: fbp || undefined,
    }

    const event_time = typeof eventTimeIn === 'number' && Number.isFinite(eventTimeIn)
      ? Math.floor(eventTimeIn)
      : Math.floor(Date.now() / 1000)

    const customEvent = {
      event_name: eventName,
      event_time,
      action_source: 'website',
      event_source_url: pageUrl,
      event_id: eventId || undefined,
      user_data,
      ...(value && currency ? { value: parseFloat(value), currency } : {}),
    }

    // SOLO custom. NUNCA mandar Lead (categoría Health quema el píxel). events_received:1.
    const payload = {
      data: [customEvent],
      access_token: CAPI_TOKEN,
      ...(testCode ? { test_event_code: testCode } : {}),
    }

    const res = await fetch(CAPI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const data = await res.json()
    console.log('[capi]', JSON.stringify(data))
    return Response.json(data, {
      status: res.ok ? 200 : 502,
      headers: CORS_HEADERS,
    })
  } catch (err) {
    return Response.json(
      { error: String(err) },
      { status: 500, headers: CORS_HEADERS }
    )
  }
}
