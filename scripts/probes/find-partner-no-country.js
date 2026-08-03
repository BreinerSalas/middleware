// Sonda (solo lectura): busca un partner de ventas sin country_id para el camino negativo (paso 7).
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
  const ids = await rpc('res.partner', 'search', [[
    ['country_id', '=', false],
    ['customer_rank', '>', 0]
  ]], { limit: 5 })
  console.log('candidatos (customer_rank>0, sin country_id):', ids)

  if (ids.length) {
    const recs = await rpc('res.partner', 'read', [ids], { fields: ['id', 'name', 'parent_id', 'customer_rank'] })
    for (const r of recs) console.log(' ', JSON.stringify(r))
  } else {
    console.log('ninguno con customer_rank>0; probando sin ese filtro...')
    const anyIds = await rpc('res.partner', 'search', [[['country_id', '=', false]]], { limit: 5 })
    console.log('candidatos sin country_id (cualquier tipo):', anyIds)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
