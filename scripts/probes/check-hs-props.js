// Sonda P7 (solo lectura): verifica que las propiedades de deal existan en HubSpot.
require('dotenv').config()

const NAMES = [
  process.env.HS_PROPERTY_ODOO_QUOTE_ID || 'id_presupuesto_odoo',
  process.env.HS_PROPERTY_ODOO_CUSTOMER_ID || 'id_cliente_odoo',
  process.env.HS_PROPERTY_ODOO_ORDER_ID || 'id_orden_odoo'
]

async function main() {
  const base = process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com'
  const token = (process.env.HUBSPOT_ACCESS_TOKEN || '').trim()
  console.log(`token: len=${token.length} prefix=${token.slice(0, 10)}`)

  for (const name of NAMES) {
    const res = await fetch(`${base}/crm/v3/properties/deals/${name}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const body = await res.json().catch(() => ({}))
    if (res.ok) {
      console.log(`OK   ${name}  type=${body.type}/${body.fieldType}  label="${body.label}"`)
    } else {
      console.log(`FAIL ${name}  HTTP ${res.status}  ${body.message || ''}`)
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
