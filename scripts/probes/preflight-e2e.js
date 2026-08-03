// Pre-vuelo E2E (solo lectura): linea base de mrp.production + pais del partner.
// Uso: node scripts/probes/preflight-e2e.js [partnerId]
require('dotenv').config()

const { createOdooApiClient } = require('../../src/adapters/outbound/odoo/odooApiClient')

// JSON-RPC crudo: el cliente no expone executeKw, y para la linea base del paso 8
// solo necesitamos search_count sobre mrp.production.
async function rawExecuteKw(model, method, args) {
  const base = process.env.ODOO_BASE_URL
  const db = process.env.ODOO_DB
  const login = process.env.ODOO_LOGIN
  const key = process.env.ODOO_API_KEY

  const call = async (service, method2, params) => {
    const res = await fetch(`${base}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method: method2, args: params }, id: 1 })
    })
    const body = await res.json()
    if (body.error) throw new Error(JSON.stringify(body.error.data || body.error))
    return body.result
  }

  const uid = await call('common', 'login', [db, login, key])
  return call('object', 'execute_kw', [db, uid, key, model, method, args])
}

async function main() {
  const partnerId = Number(process.argv[2] || process.env.ODOO_DEFAULT_CUSTOMER_ID)
  const client = createOdooApiClient({
    mode: process.env.ODOO_CLIENT_MODE,
    baseUrl: process.env.ODOO_BASE_URL,
    db: process.env.ODOO_DB,
    login: process.env.ODOO_LOGIN,
    apiKey: process.env.ODOO_API_KEY
  })

  const countries = await client.readPartnerCountries([partnerId])
  const partner = countries[partnerId] || countries[String(partnerId)] || null
  console.log(`partner ${partnerId}:`, JSON.stringify(partner))

  const costs = await client.listOperationCosts()
  console.log(`operation.costs cargados: ${costs.length}`)

  if (partner && partner.countryId) {
    // Mismo orden que OdooTargetGateway.resolveCountryExpense: filtrar por countryId,
    // despues desempatar por nombre "DDP <pais>".
    const { pickOperationCostForCountry } = require('../../src/adapters/outbound/odoo/operationCostsResolver')
    const forCountry = costs.filter((r) => r && r.countryId === partner.countryId)
    console.log(`registros del pais ${partner.countryName}: ${forCountry.length}`)
    console.log('  ', forCountry.map((r) => `${r.id}:${r.name}`).join(' | ') || '(ninguno)')
    console.log('pick =>', JSON.stringify(pickOperationCostForCountry(forCountry, partner.countryName)))
  } else {
    console.log('pick => sin country_id en el partner; se espera status=unresolved')
  }

  const totalMos = await rawExecuteKw('mrp.production', 'search_count', [[]])
  const hsMos = await rawExecuteKw('mrp.production', 'search_count', [[['origin', 'like', 'hs:%']]])
  console.log(`\nLINEA BASE paso 8 -> mrp.production total=${totalMos}  con origin hs:*=${hsMos}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
