import { createHash } from 'crypto'

const PIXEL_ID = process.env.PIXEL_ID!
const CAPI_TOKEN = process.env.CAPI_TOKEN!
const CAPI_URL = `https://graph.facebook.com/v18.0/${PIXEL_ID}/events`

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function sha256(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex')
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '')
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

export async function POST(req: Request) {
  try {
    const { email, phone, firstName, fbp, fbc, clientIp, clientUserAgent, eventName, testCode, value, currency } =
      await req.json()

    const userData: Record<string, string> = {}
    if (email)           userData.em = sha256(email)
    if (phone)           userData.ph = sha256(normalizePhone(phone))
    if (firstName)       userData.fn = sha256(firstName)
    if (fbp)             userData.fbp = fbp
    if (fbc)             userData.fbc = fbc
    if (clientIp)        userData.client_ip_address = clientIp
    if (clientUserAgent) userData.client_user_agent = clientUserAgent

    const payload = {
      data: [
        {
          event_name: eventName || 'consulta_solicitada',
          event_time: Math.floor(Date.now() / 1000),
          action_source: 'website',
          event_source_url: 'https://momentodemudanca.com',
          user_data: userData,
          ...(value && currency ? { value: parseFloat(value), currency } : {}),
        },
      ],
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
