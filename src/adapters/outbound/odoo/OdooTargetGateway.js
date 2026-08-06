'use strict'

const { mapDealToSaleOrder, resolveProductId } = require('./dealToSaleOrderMapper')
const { normalizeProductName } = require('./productNameKey')
const { pickOperationCostForCountry } = require('./operationCostsResolver')
const { SkipSyncError, TransientSyncError } = require('../../../core/domain/errors')

function applySkuMatch(li, map) {
  if (!li) return li
  const sku = li.hs_sku != null ? String(li.hs_sku) : null
  const resolved = sku && map[sku] != null ? map[sku] : null
  if (resolved == null) return li
  const enriched = { ...li }
  if (typeof resolved === 'object') {
    if (resolved.id != null) enriched.productId = Number(resolved.id)
    if (resolved.uomId != null) enriched.productUomId = Number(resolved.uomId)
  } else {
    enriched.productId = Number(resolved)
  }
  return enriched
}

function applyNameMatch(li, map) {
  if (!li || resolveProductId(li) != null) return li
  const key = normalizeProductName(li.name)
  const entry = key ? map[key] : null
  if (entry == null) return li
  if (typeof entry !== 'object') return { ...li, productId: Number(entry) }
  if (Number(entry.matches) > 1) {
    return {
      ...li,
      productResolutionError: 'name_ambiguous',
      productNameCandidates: Array.isArray(entry.ids) ? entry.ids : []
    }
  }
  const enriched = { ...li }
  if (entry.id != null) enriched.productId = Number(entry.id)
  if (entry.uomId != null) enriched.productUomId = Number(entry.uomId)
  return enriched
}

function collectUnresolvedLines(lineItems) {
  const out = []
  for (const li of Array.isArray(lineItems) ? lineItems : []) {
    if (!li || resolveProductId(li) != null) continue
    const hsSku = li.hs_sku == null || String(li.hs_sku) === '' ? null : String(li.hs_sku)
    const name = li.name == null || String(li.name).trim() === '' ? null : String(li.name)
    let reason = 'not_found'
    if (li.productResolutionError === 'name_ambiguous') reason = 'name_ambiguous'
    else if (!hsSku && !name) reason = 'no_name_no_sku'
    const entry = { lineItemId: li.id != null ? String(li.id) : null, name, hsSku, reason }
    if (reason === 'name_ambiguous') {
      entry.candidates = Array.isArray(li.productNameCandidates) ? li.productNameCandidates : []
    }
    out.push(entry)
  }
  return out
}

function describeUnresolved(u) {
  const sku = u.hsSku ? `"${u.hsSku}"` : 'ninguno'
  const name = u.name ? `"${u.name}"` : 'sin nombre'
  const base = `line item ${u.lineItemId}: nombre ${name} / hs_sku ${sku}`
  if (u.reason === 'name_ambiguous') {
    const ids = (u.candidates || []).join(', ')
    return `${base} — ${(u.candidates || []).length} productos de Odoo comparten ese nombre (${ids}); definí hs_sku para desambiguar`
  }
  if (u.reason === 'no_name_no_sku') return `${base} — el line item no tiene hs_sku ni nombre`
  return `${base} — ningún producto de Odoo coincide por default_code ni por nombre`
}

function buildSaleOrderUpdatePayload({ saleOrder, existing } = {}) {
  if (!saleOrder) return {}
  const payload = { origin: saleOrder.origin, partner_id: saleOrder.partner_id }
  const exp = existing || {}
  if (saleOrder.country_expense != null && !exp.countryExpenseId) {
    payload.country_expense = saleOrder.country_expense
  }
  if (saleOrder.note && !exp.note) {
    payload.note = saleOrder.note
  }
  if (Array.isArray(saleOrder.order_line)) {
    // [5, 0, 0] = Odoo "unlink all" o2m command — reemplaza las líneas por completo con
    // las de HubSpot en cada re-sync (ver plan Fase 6: ventas corrige cantidades en HubSpot
    // y el ciclo cancelar/corregir/cerrar-ganado necesita que lleguen a Odoo).
    payload.order_line = [[5, 0, 0], ...saleOrder.order_line]
  }
  return payload
}

const SMARTFLOW_MARKER = '[smartflow] País no resuelto: revisar country_expense antes de confirmar.'

async function resolveCountryIdFromPartner(odooCustomerId, { apiClient, logger = null, correlationId = null } = {}) {
  const empty = { countryId: null, countryName: null, reason: null }
  const numericId = odooCustomerId != null && Number.isFinite(Number(odooCustomerId)) ? Number(odooCustomerId) : null
  if (numericId == null) {
    return { ...empty, reason: 'no_odoo_customer_id' }
  }
  if (!apiClient || typeof apiClient.readPartnerCountries !== 'function') {
    return { ...empty, reason: 'readPartnerCountries_not_supported' }
  }
  let partner = null
  try {
    const map = await apiClient.readPartnerCountries([numericId]) || {}
    partner = map[numericId] || null
    const seen = new Set()
    while (partner && !partner.countryId && partner.parentId && !seen.has(Number(partner.parentId))) {
      seen.add(Number(partner.parentId))
      let parentMap = {}
      try {
        parentMap = await apiClient.readPartnerCountries([Number(partner.parentId)]) || {}
      } catch (parentErr) {
        if (logger) logger.warn('odoo.upsert.readPartnerCountries.parent failed', { error: parentErr.message, correlationId })
        break
      }
      partner = parentMap[Number(partner.parentId)] || null
    }
  } catch (err) {
    if (logger) logger.warn('odoo.upsert.readPartnerCountries failed', { error: err.message, correlationId })
    return { ...empty, reason: 'partner_lookup_failed' }
  }
  if (!partner || !partner.countryId) {
    return { ...empty, reason: 'partner_has_no_country' }
  }
  return { countryId: partner.countryId, countryName: partner.countryName || null }
}

async function resolveCountryIdFromIsoCode(iso, { apiClient, logger = null } = {}) {
  const empty = { countryId: null, countryName: null, reason: null }
  if (iso == null || String(iso).trim() === '') {
    return { ...empty, reason: 'missing_iso' }
  }
  if (!apiClient || typeof apiClient.searchCountryIdsByCodes !== 'function') {
    return { ...empty, reason: 'searchCountryIdsByCodes_not_supported' }
  }
  let result = {}
  try {
    result = await apiClient.searchCountryIdsByCodes([String(iso).trim()]) || {}
  } catch (err) {
    if (logger) logger.warn('odoo.upsert.searchCountryIdsByCodes failed', { iso, error: err.message })
    return { ...empty, reason: 'searchCountryIdsByCodes_failed' }
  }
  const hit = result[String(iso).trim()]
  if (!hit) {
    return { ...empty, reason: 'quote_country_iso_not_found' }
  }
  return { countryId: hit.id, countryName: hit.name || null }
}

async function pickCountryExpenseRecord({ countryId, countryName, apiClient, logger = null, correlationId = null } = {}) {
  const empty = {
    status: 'unresolved',
    id: null,
    countryId,
    countryName: countryName || null,
    reason: null,
    matches: 0,
    ambiguous: false
  }
  if (!apiClient || typeof apiClient.listOperationCosts !== 'function') {
    return { ...empty, reason: 'listOperationCosts_not_supported' }
  }
  let records = []
  try {
    records = await apiClient.listOperationCosts() || []
  } catch (err) {
    if (logger) logger.warn('odoo.upsert.listOperationCosts failed', { error: err.message, correlationId })
    return { ...empty, reason: 'operation_costs_lookup_failed' }
  }
  const countryRecords = records.filter((r) => r && r.countryId === countryId)
  const picked = pickOperationCostForCountry(countryRecords, countryName)
  if (!picked) {
    return { ...empty, reason: 'no_operation_cost_for_country' }
  }
  return {
    status: 'resolved',
    id: picked.id,
    countryId,
    countryName: countryName || null,
    reason: picked.reason || 'ddp_exact_match',
    matches: picked.matches,
    ambiguous: picked.ambiguous
  }
}

class OdooTargetGateway {
  constructor({ apiClient, hashPayload, logger = null, defaultCustomerId = '', requireProductMatch = true, propertyQuoteCountry = 'pais_de_destino', autoConfirm = false } = {}) {
    if (!apiClient) throw new Error('OdooTargetGateway requires apiClient')
    if (typeof hashPayload !== 'function') throw new Error('OdooTargetGateway requires hashPayload')
    this.apiClient = apiClient
    this.hashPayload = hashPayload
    this.logger = logger
    this.defaultCustomerId = defaultCustomerId ? String(defaultCustomerId) : ''
    this.requireProductMatch = requireProductMatch !== false
    this.propertyQuoteCountry = propertyQuoteCountry || 'pais_de_destino'
    this.autoConfirm = autoConfirm === true
  }

  async upsert({ existingTargetId = null, record, references = {}, correlationId = null } = {}) {
    if (!record) throw new Error('OdooTargetGateway.upsert requires record')
    // existingTargetId se acepta por contrato del puerto pero se ignora deliberadamente:
    // las filas viejas de mappings tienen ids de mrp.production, no de sale.order.
    // Pasarlos a updateSalesOrder corrompería el SO que casualmente comparta ese entero.
    void existingTargetId

    const odooCustomerId =
      (references && references.odooCustomerId) ||
      (record.properties && record.properties.id_cliente_odoo) ||
      this.defaultCustomerId ||
      null
    const hsLineItems = (references && references.lineItems) || []

    const withProductIds = await this.resolveProductIds(hsLineItems, correlationId)
    const enrichedLineItems = await this.resolveProductUoms(withProductIds, correlationId)

    if (this.requireProductMatch) this.assertProductsResolved(enrichedLineItems, record, correlationId)

    const countryExpense = record && record.quote
      ? await this.resolveCountryExpenseFromQuote(record.quote, odooCustomerId, correlationId)
      : await this.resolveCountryExpense(odooCustomerId, correlationId)

    let payload
    try {
      payload = mapDealToSaleOrder({
        hsDeal: record,
        odooCustomerId,
        hsLineItems: enrichedLineItems,
        countryExpenseId: countryExpense.status === 'resolved' ? countryExpense.id : null,
        dealId: record.dealId || null,
        quoteId: record.quoteId || null,
        quote: record.quote || null,
        countryCodeProperty: this.propertyQuoteCountry
      })
    } catch (err) {
      if (err.code === 'MISSING_ODOO_CUSTOMER_ID') {
        const t = new Error('Missing Odoo customer reference for HubSpot deal')
        t.transient = true
        t.code = 'MISSING_ODOO_CUSTOMER_ID'
        t.cause = err
        throw t
      }
      throw err
    }

    if (countryExpense.status === 'unresolved') {
      payload.saleOrder.note = payload.saleOrder.note
        ? `${payload.saleOrder.note}\n${SMARTFLOW_MARKER}`
        : SMARTFLOW_MARKER
    }

    const soResult = await this.upsertSalesOrder({ payload, correlationId })

    const confirmation = this.autoConfirm
      ? await this.confirmSalesOrder(soResult.id, correlationId)
      : null

    const manufacturingOrder = (confirmation && confirmation.status === 'confirmed' && soResult.name)
      ? await this.findManufacturingOrder(soResult.name, correlationId)
      : null

    return {
      targetId: String(soResult.id),
      targetRef: soResult.name || null,
      syncToken: soResult.state || null,
      raw: soResult.payload,
      payloadHash: this.hashPayload({ saleOrder: payload.saleOrder }),
      salesOrderId: String(soResult.id),
      metadata: {
        countryExpense: {
          status: countryExpense.status,
          id: countryExpense.id,
          countryId: countryExpense.countryId,
          countryName: countryExpense.countryName,
          reason: countryExpense.reason,
          matches: countryExpense.matches,
          ambiguous: countryExpense.ambiguous
        },
        confirmation,
        manufacturingOrder
      }
    }
  }

  async findManufacturingOrder(salesOrderName, correlationId) {
    try {
      const mo = await this.apiClient.findManufacturingOrderBySaleOrderName(salesOrderName)
      return mo || null
    } catch (err) {
      if (this.logger) {
        this.logger.warn('odoo.upsert.manufacturingOrder.lookup_failed', { salesOrderName, error: err.message, correlationId })
      }
      return null
    }
  }

  async confirmSalesOrder(salesOrderId, correlationId) {
    try {
      await this.apiClient.confirmSalesOrder(salesOrderId)
      if (this.logger) this.logger.info('odoo.upsert.salesOrder.confirmed', { salesOrderId, correlationId })
      return { status: 'confirmed', reason: null }
    } catch (err) {
      if (this.logger) {
        this.logger.warn('odoo.upsert.salesOrder.confirm_rejected', { salesOrderId, error: err.message, correlationId })
      }
      return { status: 'rejected', reason: err.message }
    }
  }

  async resolveCountryExpense(odooCustomerId, correlationId) {
    const empty = {
      status: 'unresolved',
      id: null,
      countryId: null,
      countryName: null,
      reason: null,
      matches: 0,
      ambiguous: false
    }

    const numericId = odooCustomerId != null && Number.isFinite(Number(odooCustomerId)) ? Number(odooCustomerId) : null
    if (numericId == null) {
      return { ...empty, reason: 'no_odoo_customer_id' }
    }

    if (typeof this.apiClient.readPartnerCountries !== 'function') {
      return { ...empty, reason: 'readPartnerCountries_not_supported' }
    }

    let partner = null
    try {
      const map = await this.apiClient.readPartnerCountries([numericId]) || {}
      partner = map[numericId] || null
      const seen = new Set()
      while (partner && !partner.countryId && partner.parentId && !seen.has(Number(partner.parentId))) {
        seen.add(Number(partner.parentId))
        let parentMap = {}
        try {
          parentMap = await this.apiClient.readPartnerCountries([Number(partner.parentId)]) || {}
        } catch (parentErr) {
          if (this.logger) this.logger.warn('odoo.upsert.readPartnerCountries.parent failed', { error: parentErr.message, correlationId })
          break
        }
        partner = parentMap[Number(partner.parentId)] || null
      }
    } catch (err) {
      if (this.logger) this.logger.warn('odoo.upsert.readPartnerCountries failed', { error: err.message, correlationId })
      return { ...empty, reason: 'partner_lookup_failed' }
    }

    if (!partner || !partner.countryId) {
      return { ...empty, reason: 'partner_has_no_country' }
    }

    const countryId = partner.countryId
    const countryName = partner.countryName

    if (typeof this.apiClient.listOperationCosts !== 'function') {
      return { ...empty, countryId, countryName, reason: 'listOperationCosts_not_supported' }
    }

    let records = []
    try {
      records = await this.apiClient.listOperationCosts() || []
    } catch (err) {
      if (this.logger) this.logger.warn('odoo.upsert.listOperationCosts failed', { error: err.message, correlationId })
      return { ...empty, countryId, countryName, reason: 'operation_costs_lookup_failed' }
    }

    const countryRecords = records.filter((r) => r && r.countryId === countryId)
    const picked = pickOperationCostForCountry(countryRecords, countryName)

    if (!picked) {
      return { ...empty, countryId, countryName, reason: 'no_operation_cost_for_country' }
    }

    return {
      status: 'resolved',
      id: picked.id,
      countryId,
      countryName,
      reason: picked.reason || 'ddp_exact_match',
      matches: picked.matches,
      ambiguous: picked.ambiguous
    }
  }

  async resolveCountryExpenseFromQuote(quote, odooCustomerId, correlationId) {
    const empty = {
      status: 'unresolved',
      id: null,
      countryId: null,
      countryName: null,
      reason: null,
      matches: 0,
      ambiguous: false
    }
    const countryProp = this.propertyQuoteCountry || 'pais_de_destino'
    const iso = quote && quote.properties ? quote.properties[countryProp] : null
    if (iso) {
      const resolved = await resolveCountryIdFromIsoCode(iso, { apiClient: this.apiClient, logger: this.logger })
      if (resolved.countryId) {
        const picked = await pickCountryExpenseRecord({
          countryId: resolved.countryId,
          countryName: resolved.countryName,
          apiClient: this.apiClient,
          logger: this.logger,
          correlationId
        })
        if (picked.status === 'resolved') return picked
        return { ...empty, countryId: resolved.countryId, countryName: resolved.countryName, reason: picked.reason || 'no_operation_cost_for_country' }
      }
      // ISO no resolvío — cae al partner walk con marca diagnóstica
      const fromPartner = await resolveCountryIdFromPartner(odooCustomerId, { apiClient: this.apiClient, logger: this.logger, correlationId })
      if (!fromPartner.countryId) {
        return {
          ...empty,
          reason: resolved.reason || 'quote_country_iso_not_found'
        }
      }
      const picked = await pickCountryExpenseRecord({
        countryId: fromPartner.countryId,
        countryName: fromPartner.countryName,
        apiClient: this.apiClient,
        logger: this.logger,
        correlationId
      })
      if (picked.status === 'resolved') {
        return { ...picked, reason: 'partner_walk_after_iso_miss' }
      }
      return { ...empty, countryId: fromPartner.countryId, countryName: fromPartner.countryName, reason: 'partner_walk_after_iso_miss' }
    }
    // Sin ISO en la quote — comportamiento legacy
    return await this.resolveCountryExpense(odooCustomerId, correlationId)
  }

  async upsertSalesOrder({ payload, correlationId }) {
    const existing = await this.resolveExistingSalesOrder({ payload, correlationId })
    if (existing) {
      let state = existing.state || null
      if (state === 'cancel') {
        await this.apiClient.reviveSalesOrderToDraft(existing.id)
        if (this.logger) this.logger.info('odoo.upsert.salesOrder.revived', { salesOrderId: existing.id, correlationId })
        state = 'draft'
      }
      const updatePayload = buildSaleOrderUpdatePayload({ saleOrder: payload.saleOrder, existing })
      const updated = await this.apiClient.updateSalesOrder(existing.id, updatePayload)
      if (this.logger) this.logger.info('odoo.upsert.salesOrder.update', { salesOrderId: existing.id, correlationId })
      return {
        id: String(existing.id),
        name: existing.name || null,
        state,
        created: false,
        payload: updatePayload
      }
    }
    const created = await this.apiClient.createSalesOrder(payload.saleOrder)
    if (this.logger) this.logger.info('odoo.upsert.salesOrder.create', { salesOrderId: created.id, correlationId })
    return {
      id: String(created.id),
      name: created.ref || null,
      state: created.state || 'draft',
      created: true,
      payload: payload.saleOrder
    }
  }

  async resolveExistingSalesOrder({ payload, correlationId }) {
    try {
      const found = await this.apiClient.searchSalesOrderByOrigin(payload.saleOrder.origin)
      if (!Array.isArray(found) || found.length === 0) return null
      const first = found[0]
      if (first && typeof first === 'object') {
        return {
          id: Number(first.id),
          name: first.name || null,
          state: first.state || null,
          countryExpenseId: first.countryExpenseId != null ? Number(first.countryExpenseId) : null,
          note: first.note || null
        }
      }
      // Retrocompat: tests/fixtures pueden pasar el id pelado (string o número)
      return {
        id: first,
        name: null,
        state: null,
        countryExpenseId: null,
        note: null
      }
    } catch (err) {
      if (this.logger) this.logger.warn('odoo.upsert.searchSalesOrder failed', { error: err.message, correlationId })
      return null
    }
  }

  async resolveProductIds(lineItems, correlationId) {
    if (!Array.isArray(lineItems) || lineItems.length === 0) return []
    const bySku = await this.lookupByDefaultCode(lineItems, correlationId)
    const staged = lineItems.map((li) => applySkuMatch(li, bySku))
    const byName = await this.lookupByName(staged, correlationId)
    return staged.map((li) => applyNameMatch(li, byName))
  }

  async lookupByDefaultCode(lineItems, correlationId) {
    const needsLookup = []
    const seen = new Set()
    for (const li of lineItems) {
      const sku = li && li.hs_sku != null ? String(li.hs_sku) : ''
      const numeric = /^\d+$/.test(sku)
      const hasProductId = li && li.productId != null
      if (!hasProductId && !numeric && sku && !seen.has(sku)) {
        seen.add(sku)
        needsLookup.push(sku)
      }
    }
    if (needsLookup.length === 0) return {}
    try {
      return await this.apiClient.searchProductIdsByDefaultCodes(needsLookup) || {}
    } catch (err) {
      if (this.logger) this.logger.warn('odoo.upsert.lookupProducts failed', { error: err.message, correlationId })
      throw new TransientSyncError('Odoo product lookup by default_code failed', { cause: err })
    }
  }

  async lookupByName(lineItems, correlationId) {
    if (typeof this.apiClient.searchProductIdsByNames !== 'function') return {}
    const names = []
    const seen = new Set()
    for (const li of lineItems) {
      if (!li || resolveProductId(li) != null) continue
      const key = normalizeProductName(li.name)
      if (!key || seen.has(key)) continue
      seen.add(key)
      names.push(li.name)
    }
    if (names.length === 0) return {}
    try {
      return await this.apiClient.searchProductIdsByNames(names) || {}
    } catch (err) {
      if (this.logger) this.logger.warn('odoo.upsert.lookupProductsByName failed', { error: err.message, correlationId })
      throw new TransientSyncError('Odoo product lookup by name failed', { cause: err })
    }
  }

  assertProductsResolved(lineItems, record, correlationId = null) {
    const unresolved = collectUnresolvedLines(lineItems)
    if (unresolved.length === 0) return
    const sourceId = record && record.id != null ? String(record.id) : null
    if (this.logger) {
      this.logger.warn('odoo.upsert.productUnresolved', { sourceId, unresolved, correlationId })
    }
    const ambiguous = unresolved.some((u) => u.reason === 'name_ambiguous')
    const code = ambiguous ? 'ODOO_PRODUCT_NAME_AMBIGUOUS' : 'ODOO_PRODUCT_NOT_FOUND'
    const extra = unresolved.length > 1 ? ` (+${unresolved.length - 1} más)` : ''
    const message = `Producto Odoo no resuelto para ${describeUnresolved(unresolved[0])}${extra}`
    throw new SkipSyncError(message, { detail: { code, sourceId, unresolved } })
  }

  async resolveProductUoms(lineItems, correlationId) {
    if (!Array.isArray(lineItems) || lineItems.length === 0) return []
    if (typeof this.apiClient.readProductUoms !== 'function') return lineItems
    const needsUom = []
    const seen = new Set()
    for (const li of lineItems) {
      if (!li || li.productUomId != null) continue
      const productId = resolveProductId(li)
      if (productId == null || seen.has(productId)) continue
      seen.add(productId)
      needsUom.push(productId)
    }
    if (needsUom.length === 0) return lineItems
    let map = {}
    try {
      map = await this.apiClient.readProductUoms(needsUom) || {}
    } catch (err) {
      if (this.logger) this.logger.warn('odoo.upsert.readProductUoms failed', { error: err.message, correlationId })
      return lineItems
    }
    return lineItems.map((li) => {
      if (!li || li.productUomId != null) return li
      const productId = resolveProductId(li)
      const uomId = productId == null ? null : map[productId]
      if (uomId == null) return li
      return { ...li, productUomId: Number(uomId) }
    })
  }
}

module.exports = { OdooTargetGateway, collectUnresolvedLines, buildSaleOrderUpdatePayload, resolveCountryIdFromPartner, resolveCountryIdFromIsoCode, pickCountryExpenseRecord }
