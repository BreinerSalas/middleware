'use strict'

function mapDealToManufacturingOrder({ hsDeal, odooCustomerId, hsLineItems = [], now = new Date() } = {}) {
  if (!hsDeal) throw new Error('mapDealToManufacturingOrder requires hsDeal')
  if (!odooCustomerId) {
    const err = new Error('odooCustomerId is required to build manufacturing order payload')
    err.code = 'MISSING_ODOO_CUSTOMER_ID'
    throw err
  }
  const origin = `hs:${hsDeal.id}`
  const productLine = (Array.isArray(hsLineItems) ? hsLineItems[0] : null) || {}
  return {
    origin,
    partner_id: Number(odooCustomerId) || odooCustomerId,
    product_id: productLine.hs_sku ? Number(productLine.hs_sku) || productLine.hs_sku : (productLine.productId || null),
    product_qty: productLine.quantity || 1,
    date_planned: now.toISOString(),
    company_id: 1,
    note: hsDeal.properties && hsDeal.properties.dealname ? `Deal: ${hsDeal.properties.dealname}` : undefined,
    x_hubspot_deal_id: String(hsDeal.id),
    line_items: (Array.isArray(hsLineItems) ? hsLineItems : []).map((li) => ({
      product_id: li.hs_sku ? Number(li.hs_sku) || li.hs_sku : (li.productId || null),
      name: li.name || null,
      product_qty: li.quantity || 1,
      price_unit: li.price || li.unitPrice || 0
    }))
  }
}

module.exports = { mapDealToManufacturingOrder }
