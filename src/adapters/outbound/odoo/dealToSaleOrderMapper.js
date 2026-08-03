'use strict'

function resolveProductId(line) {
  if (!line) return null
  if (line.productId != null) return line.productId
  if (line.hs_sku != null && /^\d+$/.test(String(line.hs_sku))) return Number(line.hs_sku)
  return null
}

function mapDealToSaleOrder({
  hsDeal,
  odooCustomerId,
  hsLineItems = [],
  countryExpenseId = null,
  origin = null,
  dealId = null,
  quoteId = null,
  quote = null,
  countryCodeProperty = 'pais_de_destino'
} = {}) {
  if (!hsDeal) throw new Error('mapDealToSaleOrder requires hsDeal')
  if (!odooCustomerId) {
    const err = new Error('odooCustomerId is required to build sale order payload')
    err.code = 'MISSING_ODOO_CUSTOMER_ID'
    throw err
  }

  let resolvedOrigin = origin
  if (!resolvedOrigin) {
    const dId = dealId || hsDeal.id
    resolvedOrigin = quoteId ? `hs:${dId}:q${quoteId}` : `hs:${dId}`
  }

  const dealName = hsDeal.properties && hsDeal.properties.dealname
  const noteLines = []
  if (dealName) noteLines.push(`Deal: ${dealName}`)
  if (quote && quote.properties) {
    const title = quote.properties.hs_title
    const iso = countryCodeProperty ? quote.properties[countryCodeProperty] : null
    if (title) {
      noteLines.push(iso ? `Cotización: ${title} (${iso})` : `Cotización: ${title}`)
    }
  }
  const note = noteLines.length > 0 ? noteLines.join('\n') : undefined

  const items = Array.isArray(hsLineItems) ? hsLineItems : []

  const orderLines = items.map((li) => {
    const line = {
      product_id: resolveProductId(li),
      name: li.name || null,
      product_uom_qty: li.quantity || 1,
      price_unit: li.price || li.unitPrice || 0
    }
    if (li.productUomId != null) line.product_uom = Number(li.productUomId)
    return [0, 0, line]
  })

  const saleOrder = {
    origin: resolvedOrigin,
    partner_id: Number(odooCustomerId) || odooCustomerId,
    order_line: orderLines,
    note
  }

  if (countryExpenseId != null) {
    saleOrder.country_expense = Number(countryExpenseId)
  }

  return { saleOrder }
}

module.exports = { mapDealToSaleOrder, resolveProductId }
