// Verificacion paso 3/4/6 (solo lectura): estado del presupuesto y sus MOs.
// Uso: node scripts/probes/inspect-quote.js <saleOrderId> [dealId]
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

async function main() {
  const soId = Number(process.argv[2])
  const dealId = process.argv[3] || null

  const [so] = await rpc('sale.order', 'read', [[soId]], {
    fields: ['name', 'state', 'partner_id', 'origin', 'country_expense', 'destination_taxes',
      'amount_total', 'order_line', 'note', 'procurement_group_id']
  })

  console.log('=== SALE ORDER ===')
  console.log(`name=${so.name}  state=${so.state}  origin=${so.origin}`)
  console.log(`partner=${JSON.stringify(so.partner_id)}`)
  console.log(`country_expense=${JSON.stringify(so.country_expense)}`)
  console.log(`destination_taxes=${so.destination_taxes}  amount_total=${so.amount_total}`)
  console.log(`procurement_group_id=${JSON.stringify(so.procurement_group_id)}`)
  console.log(`note=${JSON.stringify(so.note)}`)

  const lines = await rpc('sale.order.line', 'read', [so.order_line], {
    fields: ['name', 'product_id', 'product_uom_qty', 'price_unit']
  })
  console.log(`\n=== ORDER LINES (${lines.length}) ===`)
  for (const l of lines) {
    console.log(`  [${l.id}] ${JSON.stringify(l.product_id)}  qty=${l.product_uom_qty}  precio=${l.price_unit}  "${l.name}"`)
  }

  const byName = await rpc('mrp.production', 'search_read', [[['origin', '=', so.name]]], {
    fields: ['name', 'origin', 'state', 'product_id', 'product_qty', 'move_dest_ids']
  })
  console.log(`\n=== MOs con origin="${so.name}" (${byName.length}) ===`)
  for (const m of byName) {
    console.log(`  ${m.name}  state=${m.state}  ${JSON.stringify(m.product_id)}  qty=${m.product_qty}  move_dest_ids=${JSON.stringify(m.move_dest_ids)}`)
  }

  if (dealId) {
    const stray = await rpc('mrp.production', 'search_count', [[['origin', '=', `hs:${dealId}`]]])
    console.log(`\n=== MOs sueltas con origin="hs:${dealId}" (debe ser 0) => ${stray} ===`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
