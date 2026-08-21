// Solo lectura: sin modo desarrollador en Odoo, esto reemplaza la inspección
// manual de campos técnicos. Lista los campos de sale.order y operation.costs
// relacionados a envío/país, y los compara contra una orden real ya creada
// (para ver si el country_expense se resolvió bien pero la tabla de Gastos de
// Envío quedó vacía porque ese copy-down es un onchange que no dispara por RPC).
// Uso: node scripts/probes/inspect-gastos-envio-fields.js <saleOrderName, ej. S06643>
require('dotenv').config()

async function rpc(model, method, args, kwargs = {}) {
  const base = process.env.ODOO_BASE_URL
  const db = process.env.ODOO_DB
  const login = process.env.ODOO_LOGIN
  const key = process.env.ODOO_API_KEY

  const call = async (service, m, params) => {
    const res = await fetch(`${base}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method: m, args: params }, id: 1 })
    })
    const body = await res.json()
    if (body.error) throw new Error(JSON.stringify(body.error.data || body.error))
    return body.result
  }

  if (!rpc._uid) rpc._uid = await call('common', 'login', [db, login, key])
  return call('object', 'execute_kw', [db, rpc._uid, key, model, method, args, kwargs])
}

const CANDIDATE_RE = /gasto|envio|duca|escaner|tramite|financ|transfer|flete|dai|iva|insurance|seguro|operac|costo|via|document|otro|incoterm|pais/i

function pickCandidates(fieldsGetResult) {
  const out = {}
  for (const [name, def] of Object.entries(fieldsGetResult || {})) {
    if (CANDIDATE_RE.test(name) || CANDIDATE_RE.test(def.string || '')) {
      out[name] = { string: def.string, type: def.type, relation: def.relation || null, store: def.store, readonly: def.readonly === true }
    }
  }
  return out
}

async function main() {
  const orderName = process.argv[2]
  if (!orderName) {
    console.error('Uso: node scripts/probes/inspect-gastos-envio-fields.js <saleOrderName, ej. S06643>')
    process.exit(1)
  }

  console.log('--- fields_get(sale.order), filtrado por palabras clave de envío/país ---')
  const soFields = await rpc('sale.order', 'fields_get', [[]], { attributes: ['string', 'type', 'relation', 'store', 'readonly'] })
  const soCandidates = pickCandidates(soFields)
  console.log(JSON.stringify(soCandidates, null, 2))

  console.log('\n--- fields_get(operation.costs), todos los campos ---')
  const ocFields = await rpc('operation.costs', 'fields_get', [[]], { attributes: ['string', 'type', 'relation'] })
  console.log(JSON.stringify(ocFields, null, 2))

  console.log(`\n--- valores reales en la orden "${orderName}" ---`)
  const readFields = ['id', 'name', 'country_expense', ...Object.keys(soCandidates)]
  const [order] = await rpc('sale.order', 'search_read', [[['name', '=', orderName]]], { fields: readFields, limit: 1 })
  if (!order) {
    console.error(`No se encontró sale.order con name="${orderName}"`)
    process.exit(1)
  }
  console.log(JSON.stringify(order, null, 2))

  if (Array.isArray(order.country_expense)) {
    const opCostId = order.country_expense[0]
    console.log(`\n--- operation.costs id=${opCostId} (el que resolvió country_expense) ---`)
    const [opCost] = await rpc('operation.costs', 'read', [[opCostId]], {})
    console.log(JSON.stringify(opCost, null, 2))
  } else {
    console.log('\ncountry_expense no está seteado en esta orden (false) — no hay operation.costs para comparar.')
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
