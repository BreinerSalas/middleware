'use strict'

function resolveProductId(line) {
  if (!line) return null
  if (line.productId != null) return line.productId
  if (line.hs_sku != null && /^\d+$/.test(String(line.hs_sku))) return Number(line.hs_sku)
  return null
}

function mapDealToManufacturingOrder({ hsDeal, odooCustomerId, hsLineItems = [], now = new Date() } = {}) {
  if (!hsDeal) throw new Error('mapDealToManufacturingOrder requires hsDeal')
  if (!odooCustomerId) {
    const err = new Error('odooCustomerId is required to build manufacturing order payload')
    err.code = 'MISSING_ODOO_CUSTOMER_ID'
    throw err
  }
  const origin = `hs:${hsDeal.id}`
  const dealName = hsDeal.properties && hsDeal.properties.dealname
  const note = dealName ? `Deal: ${dealName}` : undefined
  const items = Array.isArray(hsLineItems) ? hsLineItems : []

  const orderLines = items.map((li) => [
    0,
    0,
    {
      product_id: resolveProductId(li),
      name: li.name || null,
      product_uom_qty: li.quantity || 1,
      price_unit: li.price || li.unitPrice || 0
    }
  ])

  const saleOrder = {
    origin,
    partner_id: Number(odooCustomerId) || odooCustomerId,
    order_line: orderLines,
    note
  }

const firstLine = items[0] || {}
const odooNow = now.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
const manufacturingOrder = {
    origin,
    product_id: resolveProductId(firstLine),
    product_qty: firstLine.quantity || 1,
    date_deadline: odooNow,
    company_id: 1
  }
  if (firstLine.productUomId != null) {
    manufacturingOrder.product_uom_id = Number(firstLine.productUomId)
  }

  return { saleOrder, manufacturingOrder }
}

module.exports = { mapDealToManufacturingOrder }
