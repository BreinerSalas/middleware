'use strict'

// Read-only discovery: lists ALL fields (fields_get) of a few Odoo models and ranks candidate
// Odoo fields for the HubSpot quote properties that have no Odoo match yet.
// Usage: node scripts/probes/discover-odoo-fields.js [--out <file.tsv>]

const fs = require('node:fs')

const MODELS = ['sale.order', 'sale.order.shipping.expense', 'sale.order.line', 'mrp.production', 'operation.costs']

const TARGETS = [
  { name: 'prod_monto', label: 'Mueble / Producto', keywords: ['product', 'producto', 'mueble', 'amount', 'monto', 'untaxed', 'subtotal', 'price', 'precio'] },
  { name: 'otros_cargos', label: 'Otros cargos', keywords: ['otros', 'other', 'cargo', 'charge', 'extra', 'additional', 'adicional'] },
  { name: 'comercial', label: 'Comercial', keywords: ['comercial', 'salesperson', 'vendedor', 'user', 'team', 'equipo', 'sales'] },
  { name: 'fecha_entrega_estimada', label: 'Fecha de entrega estimada', keywords: ['fecha', 'date', 'deliver', 'entrega', 'commitment', 'planned', 'prevista', 'scheduled', 'expected', 'deadline'] },
  { name: 'forma_pago', label: 'Forma de pago', keywords: ['pago', 'payment', 'term', 'plazo'] },
  { name: 'unidad_medida', label: 'Unidad de medida', keywords: ['unidad', 'uom', 'unit', 'medida', 'measure'] }
]

const LIMIT = 8

function normalize(text) {
  if (typeof text !== 'string') return ''
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

function rankCandidates(fieldsByModel, keywords, limit) {
  const kws = keywords.map(normalize).filter(Boolean)
  const out = []
  for (const [model, fields] of Object.entries(fieldsByModel)) {
    for (const [field, def] of Object.entries(fields || {})) {
      const haystack = `${normalize(field)} ${normalize(def.string)}`
      const hits = kws.filter((k) => haystack.includes(k)).length
      if (hits === 0) continue
      out.push({ model, field, label: def.string, type: def.type, store: def.store, hits })
    }
  }
  out.sort((a, b) => b.hits - a.hits ||
    (a.model < b.model ? -1 : a.model > b.model ? 1 : 0) ||
    (a.field < b.field ? -1 : a.field > b.field ? 1 : 0))
  return out.slice(0, limit)
}

function cell(v) {
  return v === undefined || v === null ? '' : String(v).replace(/[\t\r\n]+/g, ' ')
}

function toTsv(fieldsByModel) {
  const rows = [['model', 'field', 'label', 'type', 'relation', 'store', 'readonly']]
  for (const [model, fields] of Object.entries(fieldsByModel)) {
    for (const [field, def] of Object.entries(fields || {})) {
      rows.push([model, field, def.string, def.type, def.relation, def.store, def.readonly])
    }
  }
  return rows.map((r) => r.map(cell).join('\t')).join('\n')
}

// Only fields_get is ever called (plus the login the JSON-RPC session needs): strictly read-only.
const READ_ONLY_METHODS = new Set(['fields_get'])

function createRpc(env) {
  let uid = null
  const call = async (service, method, args) => {
    const res = await fetch(`${env.ODOO_BASE_URL}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: 1 })
    })
    const body = await res.json()
    if (body.error) throw new Error(JSON.stringify(body.error.data || body.error))
    return body.result
  }
  return async function rpc(model, method, args, kwargs = {}) {
    if (!READ_ONLY_METHODS.has(method)) throw new Error(`Refusing non read-only Odoo method: ${method}`)
    if (!uid) uid = await call('common', 'login', [env.ODOO_DB, env.ODOO_LOGIN, env.ODOO_API_KEY])
    return call('object', 'execute_kw', [env.ODOO_DB, uid, env.ODOO_API_KEY, model, method, args, kwargs])
  }
}

function parseOut(argv) {
  const i = argv.indexOf('--out')
  return i === -1 ? null : argv[i + 1] || null
}

async function main() {
  require('dotenv').config()
  const outFile = parseOut(process.argv.slice(2))
  if (process.argv.includes('--out') && !outFile) {
    console.error('Usage: node scripts/probes/discover-odoo-fields.js [--out <file.tsv>]')
    process.exit(1)
  }
  const rpc = createRpc(process.env)

  const fieldsByModel = {}
  for (const model of MODELS) {
    try {
      fieldsByModel[model] = await rpc(model, 'fields_get', [[]], { attributes: ['string', 'type', 'relation', 'store', 'readonly'] })
      console.log(`${model}: ${Object.keys(fieldsByModel[model]).length} fields`)
    } catch (err) {
      console.error(`${model}: skipped (${err.message})`)
    }
  }

  if (outFile) {
    fs.writeFileSync(outFile, `${toTsv(fieldsByModel)}\n`)
    console.log(`\nWrote ${outFile}`)
  }

  for (const t of TARGETS) {
    console.log(`\n${t.name} (${t.label}) - top ${LIMIT} candidates:`)
    const ranked = rankCandidates(fieldsByModel, t.keywords, LIMIT)
    if (ranked.length === 0) console.log('  (none)')
    for (const r of ranked) console.log(`  ${r.model}.${r.field} | ${r.label} | ${r.type} | store=${r.store}`)
  }
}

module.exports = { normalize, rankCandidates, toTsv }

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1) })
}
