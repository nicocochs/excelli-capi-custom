import fs from 'fs'
import path from 'path'

const CSV_PATH = path.resolve('C:/Users/Notebook/Downloads/opportunities (1).csv')
const ENDPOINT = 'https://excelli-capi-custom.vercel.app/api/event'
const DELAY_MS = 300

function parseCSV(content: string): Record<string, string>[] {
  const lines = content.split('\n').filter(l => l.trim())
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
  return lines.slice(1).map(line => {
    // Handle quoted fields with commas inside
    const fields: string[] = []
    let current = ''
    let inQuotes = false
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes }
      else if (ch === ',' && !inQuotes) { fields.push(current.trim()); current = '' }
      else { current += ch }
    }
    fields.push(current.trim())
    return Object.fromEntries(headers.map((h, i) => [h, (fields[i] ?? '').replace(/^"|"$/g, '').trim()]))
  })
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  const content = fs.readFileSync(CSV_PATH, 'utf-8')
  const rows = parseCSV(content)
  const agendados = rows.filter(r => r['fase'] === 'AGENDADO')

  console.log(`\nTotal AGENDADO: ${agendados.length}\n`)
  console.log('─'.repeat(70))

  let ok = 0
  let errors = 0

  for (const [i, row] of agendados.entries()) {
    const nombre = row['Nombre del contacto'] || row['Nombre del cliente potencial']
    const email  = row['correo electrónico']
    const phone  = row['teléfono']
    const firstName = nombre.split(' ')[0]

    process.stdout.write(`[${String(i + 1).padStart(2, '0')}/${agendados.length}] ${nombre.padEnd(40)} `)

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, phone, firstName, eventName: 'servicio_confirmado' }),
      })
      const data = await res.json() as { events_received?: number; error?: string }

      if (data.events_received === 1) {
        console.log(`✓ events_received: 1`)
        ok++
      } else {
        console.log(`✗ ${JSON.stringify(data)}`)
        errors++
      }
    } catch (err) {
      console.log(`✗ ERROR: ${err}`)
      errors++
    }

    if (i < agendados.length - 1) await sleep(DELAY_MS)
  }

  console.log('─'.repeat(70))
  console.log(`\nResumen: ${ok} exitosos, ${errors} errores de ${agendados.length} total\n`)
}

main()
