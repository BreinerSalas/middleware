'use strict'

// Read-only: cross-checks the 35 HubSpot quote properties against Odoo. For each property that
// has a mapped Odoo field it verifies the field exists (fields_get) and reads a sample value
// from one operation.costs record (and, optionally, one sale.order).
// Usage: node scripts/probes/quote-odoo-crosscheck.js <operationCostsId> [saleOrderName]

const STATUSES = [
  'odoo_operation_costs',
  'odoo_sale_order',
  'calculated_in_hubspot',
  'synced_today',
  'no_known_match',
  'not_odoo'
]

// Source: docs/mapeo-propiedades-cotizacion-hubspot-odoo.md, sections 1-5.
// `odoo` is "<model>.<field>" and is only set for odoo_* statuses.
const QUOTE_PROPERTIES = [
  // Section 1: inputs present on operation.costs
  { name: 'cargos_extra_aduana', label: 'Cargos extra de aduana', status: 'odoo_operation_costs', odoo: 'operation.costs.extra_custom_charges' },
  { name: 'gastos_duca_escaner', label: 'Gastos DUCA, escaner y transmision', status: 'odoo_operation_costs', odoo: 'operation.costs.duca_scanner_transmission' },
  { name: 'honorarios_agencia', label: 'Honorarios de agencia destino', status: 'odoo_operation_costs', odoo: 'operation.costs.destination_procedure' },
  { name: 'costo_envio_doctos', label: 'Envio de documentos a Finanzas', status: 'odoo_operation_costs', odoo: 'operation.costs.finance_docs_shipping' },
  { name: 'costo_trsf_enviada', label: 'Costo de transferencia enviada', status: 'odoo_operation_costs', odoo: 'operation.costs.trsf_cost' },
  { name: 'costo_trsf_recibida', label: 'Costo de transferencia recibida', status: 'odoo_operation_costs', odoo: 'operation.costs.received_transfer' },
  { name: 'porcentaje_financiamiento', label: 'Porcentaje de financiamiento', status: 'odoo_operation_costs', odoo: 'operation.costs.financing' },
  { name: 'porcentaje_iva', label: 'Porcentaje IVA', status: 'odoo_operation_costs', odoo: 'operation.costs.iva' },
  { name: 'porcentaje_seguro', label: 'Porcentaje de seguro', status: 'odoo_operation_costs', odoo: 'operation.costs.insurance' },
  { name: 'porcentaje_dai', label: 'Porcentaje DAI / Arancel', status: 'odoo_operation_costs', odoo: 'operation.costs.dai' },

  // Section 2: no known counterpart (flete_monto candidate: sale.order.freight)
  { name: 'prod_monto', label: 'Mueble / Producto', status: 'no_known_match', odoo: null },
  { name: 'flete_monto', label: 'Flete', status: 'odoo_sale_order', odoo: 'sale.order.freight' },
  { name: 'otros_cargos', label: 'Otros cargos', status: 'no_known_match', odoo: null },

  // Section 3: calculated in HubSpot
  { name: 'monto_seguro', label: 'Monto Seguro', status: 'calculated_in_hubspot', odoo: null },
  { name: 'valor_base_cif', label: 'Valor Base CIF', status: 'calculated_in_hubspot', odoo: null },
  { name: 'base_cif_con_otros_cargos', label: 'Base CIF con Otros Cargos', status: 'calculated_in_hubspot', odoo: null },
  { name: 'arancel_dai', label: 'Arancel DAI', status: 'calculated_in_hubspot', odoo: null },
  { name: 'impuesto_iva', label: 'Impuesto IVA', status: 'calculated_in_hubspot', odoo: null },
  { name: 'total_impuestos_aduaneros', label: 'Total Impuestos Aduaneros', status: 'calculated_in_hubspot', odoo: null },
  { name: 'total_gastos_operativos_y_logisticos', label: 'Total Gastos Operativos y Logisticos', status: 'calculated_in_hubspot', odoo: null },
  { name: 'suma_prefinanciamiento', label: 'Suma Pre-Financiamiento', status: 'calculated_in_hubspot', odoo: null },
  { name: 'costo_financiero', label: 'Costo Financiero', status: 'calculated_in_hubspot', odoo: null },

  // Section 4: already synced today
  { name: 'pais_de_destino', label: 'Pais de destino', status: 'synced_today', odoo: null },
  { name: 'incoterm_cotizacion', label: 'Incoterm', status: 'synced_today', odoo: null },
  { name: 'tipo_documento_cotizacion', label: 'Tipo de documento', status: 'synced_today', odoo: null },
  { name: 'id_presupuesto_odoo', label: 'ID presupuesto Odoo', status: 'synced_today', odoo: null },
  { name: 'estado_presupuesto_odoo', label: 'Estado presupuesto Odoo', status: 'synced_today', odoo: null },
  { name: 'estado_facturacion_odoo', label: 'Estado facturacion Odoo', status: 'synced_today', odoo: null },
  { name: 'numero_orden_fabricacion', label: 'Numero de orden de fabricacion', status: 'synced_today', odoo: null },

  // Section 5: unrelated to Odoo or undecided
  { name: 'comercial', label: 'Comercial', status: 'no_known_match', odoo: null },
  { name: 'fecha_entrega_estimada', label: 'Fecha de entrega estimada', status: 'no_known_match', odoo: null },
  { name: 'forma_pago', label: 'Forma de pago', status: 'no_known_match', odoo: null },
  { name: 'unidad_medida', label: 'Unidad de medida', status: 'no_known_match', odoo: null },
  { name: 'ocultar_campos', label: 'Ocultar campos', status: 'not_odoo', odoo: null },
  { name: 'valor_contabilizado', label: 'Valor contabilizado', status: 'not_odoo', odoo: null }
]

// Properties lacking a confirmed Odoo match: no known counterpart, or mapped field absent in Odoo.
function findUnmatched(rows) {
  return rows.filter((r) => r.status === 'no_known_match' ||
    (String(r.status).startsWith('odoo_') && r.exists === false))
}

function splitModelField(odoo) {
  const i = odoo.lastIndexOf('.')
  return { model: odoo.slice(0, i), field: odoo.slice(i + 1) }
}

function formatValue(v) {
  if (v === undefined) return '-'
  const s = JSON.stringify(v)
  return s.length > 40 ? `${s.slice(0, 37)}...` : s
}

function renderTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)))
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ')
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('-+-'), ...rows.map(line)].join('\n')
}

// Only these Odoo methods are ever called: the probe must stay strictly read-only.
const READ_ONLY_METHODS = new Set(['fields_get', 'read', 'search_read'])

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

async function main() {
  require('dotenv').config()
  const opCostId = Number(process.argv[2])
  const saleOrderName = process.argv[3] || null
  if (!Number.isInteger(opCostId) || opCostId <= 0) {
    console.error('Usage: node scripts/probes/quote-odoo-crosscheck.js <operationCostsId> [saleOrderName]')
    process.exit(1)
  }
  const rpc = createRpc(process.env)

  const models = [...new Set(QUOTE_PROPERTIES.filter((p) => p.odoo).map((p) => splitModelField(p.odoo).model))]
  const defs = {}
  for (const m of models) defs[m] = await rpc(m, 'fields_get', [[]], { attributes: ['string', 'type'] })

  const samples = {}
  const [opCost] = await rpc('operation.costs', 'read', [[opCostId]], {})
  if (!opCost) throw new Error(`No operation.costs record with id=${opCostId}`)
  samples['operation.costs'] = opCost
  if (saleOrderName) {
    const [order] = await rpc('sale.order', 'search_read', [[['name', '=', saleOrderName]]], { limit: 1 })
    if (!order) throw new Error(`No sale.order with name="${saleOrderName}"`)
    samples['sale.order'] = order
  }

  const rows = QUOTE_PROPERTIES.map((p) => {
    const row = { ...p, exists: null, type: '-', sample: undefined }
    if (!p.odoo) return row
    const { model, field } = splitModelField(p.odoo)
    const def = defs[model] && defs[model][field]
    row.exists = Boolean(def)
    row.type = def ? def.type : '-'
    if (def && samples[model]) row.sample = samples[model][field]
    return row
  })

  const yesNo = (v) => (v === null ? '-' : v ? 'yes' : 'no')
  console.log(`operation.costs id=${opCostId} (${opCost.name || 'unnamed'})${saleOrderName ? `, sale.order ${saleOrderName}` : ''}\n`)
  console.log(renderTable(
    ['HubSpot property', 'label', 'status', 'Odoo model.field', 'exists in Odoo', 'Odoo type', 'sample value'],
    rows.map((r) => [r.name, r.label, r.status, r.odoo || '-', yesNo(r.exists), r.type, formatValue(r.sample)])
  ))

  const unmatched = findUnmatched(rows)
  console.log('\nHubSpot properties WITHOUT a confirmed Odoo match:')
  if (unmatched.length === 0) console.log('(none)')
  for (const r of unmatched) {
    const why = r.status === 'no_known_match' ? 'no known Odoo counterpart' : `mapped field ${r.odoo} not found in Odoo`
    console.log(`- ${r.name} (${r.label}): ${why}`)
  }
}

module.exports = { QUOTE_PROPERTIES, STATUSES, findUnmatched }

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1) })
}
