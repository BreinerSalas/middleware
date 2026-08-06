'use strict'

const { createEchoGuard } = require('../../../core/shared/echoGuard')

const DEFAULT_DEAL_PROPERTY_NAMES = {
  dealname: 'dealname',
  dealstage: 'dealstage',
  amount: 'amount',
  closedate: 'closedate',
  pipeline: 'pipeline',
  customer: 'id_cliente_odoo',
  order: 'id_orden_odoo',
  quote: 'id_presupuesto_odoo'
}

const DEFAULT_QUOTE_PROPERTY_NAMES = {
  country: 'pais_de_destino',
  odooQuoteId: 'id_presupuesto_odoo'
}

const DEFAULT_QUOTE_ELIGIBLE_STATUSES = ['APPROVAL_NOT_NEEDED', 'APPROVED']

function parseSourceId(sourceId) {
  if (sourceId == null) return { dealId: null, quoteId: null }
  const s = String(sourceId)
  const idx = s.indexOf(':q')
  if (idx === -1) return { dealId: s, quoteId: null }
  const dealId = s.slice(0, idx)
  const quoteId = s.slice(idx + 2)
  if (!quoteId) return { dealId: s, quoteId: null }
  return { dealId, quoteId }
}

function isEligibleQuote(quote, { countryProperty, allowedStatuses } = {}) {
  if (!quote || typeof quote !== 'object') {
    return { eligible: false, reason: 'missing_quote' }
  }
  const props = quote.properties
  if (!props || typeof props !== 'object') {
    return { eligible: false, reason: 'missing_properties' }
  }
  const statuses = Array.isArray(allowedStatuses) ? allowedStatuses : DEFAULT_QUOTE_ELIGIBLE_STATUSES
  const status = props.hs_status != null ? String(props.hs_status) : null
  if (!status) {
    return { eligible: false, reason: 'missing_status' }
  }
  if (!statuses.includes(status)) {
    return { eligible: false, reason: 'status_not_eligible', detail: { status, allowed: statuses } }
  }
  const countryProp = countryProperty || DEFAULT_QUOTE_PROPERTY_NAMES.country
  const country = props[countryProp]
  if (country == null || String(country).trim() === '') {
    return { eligible: false, reason: 'missing_country' }
  }
  return { eligible: true, reason: 'ok' }
}

async function listEligibleQuotes({ dealId, sourceGateway }) {
  if (!sourceGateway || typeof sourceGateway.apiClient.getDealQuotes !== 'function') {
    throw new Error('listEligibleQuotes requires a sourceGateway with apiClient.getDealQuotes')
  }
  const quotes = await sourceGateway.apiClient.getDealQuotes(dealId)
  const result = { eligible: [], skipped: [], currencies: [] }
  const currencySet = new Set()
  for (const q of (Array.isArray(quotes) ? quotes : [])) {
    const verdict = isEligibleQuote(q, {
      countryProperty: sourceGateway.propertyQuoteCountry,
      allowedStatuses: sourceGateway.quoteEligibleStatuses
    })
    if (verdict.eligible) {
      result.eligible.push(q)
      const currency = q.properties && q.properties.hs_currency
      if (currency != null && String(currency).trim() !== '') currencySet.add(String(currency))
    } else {
      result.skipped.push({ quoteId: q.id, reason: verdict.reason })
    }
  }
  result.currencies = [...currencySet]
  return result
}

function resolvePreviousDealStage(history, currentStage) {
  if (!Array.isArray(history)) return null
  const entry = history.find((h) => h && h.value != null && h.value !== currentStage)
  return entry ? entry.value : null
}

function buildDealPropertiesToFetch(opts = {}) {
  const customer = opts.propertyOdooCustomerId || DEFAULT_DEAL_PROPERTY_NAMES.customer
  const order = opts.propertyOdooOrderId || DEFAULT_DEAL_PROPERTY_NAMES.order
  const quote = opts.propertyOdooQuoteId || DEFAULT_DEAL_PROPERTY_NAMES.quote
  return [
    'dealname', 'dealstage', 'amount', 'closedate', 'pipeline',
    customer, order, quote
  ]
}

function buildQuotePropertiesToFetch(opts = {}) {
  const country = opts.propertyQuoteCountry || DEFAULT_QUOTE_PROPERTY_NAMES.country
  const quoteId = opts.propertyOdooQuoteId || DEFAULT_DEAL_PROPERTY_NAMES.quote
  return ['hs_status', 'hs_title', 'hs_currency', 'hs_quote_amount', country, quoteId]
}

const DEFAULT_DEAL_PROPERTIES_TO_FETCH = buildDealPropertiesToFetch()

class HubspotSourceGateway {
  constructor({
    apiClient,
    propertyOdooCustomerId,
    propertyOdooOrderId,
    propertyOdooQuoteId,
    propertyQuoteOdooQuoteId,
    propertyQuoteCountry,
    propertyManufacturingOrder,
    propertyQuoteState,
    propertyQuoteInvoiceStatus,
    quoteEligibleStatuses,
    echoGuard = null,
    logger = null
  } = {}) {
    if (!apiClient) throw new Error('HubspotSourceGateway requires apiClient')
    this.apiClient = apiClient
    this.propertyOdooCustomerId = propertyOdooCustomerId || DEFAULT_DEAL_PROPERTY_NAMES.customer
    this.propertyOdooOrderId = propertyOdooOrderId || DEFAULT_DEAL_PROPERTY_NAMES.order
    this.propertyOdooQuoteId = propertyOdooQuoteId || DEFAULT_DEAL_PROPERTY_NAMES.quote
    this.propertyManufacturingOrder = propertyManufacturingOrder || 'numero_orden_fabricacion'
    this.propertyQuoteState = propertyQuoteState || 'estado_presupuesto_odoo'
    this.propertyQuoteInvoiceStatus = propertyQuoteInvoiceStatus || 'estado_facturacion_odoo'
    // The deal and the quote objects can have this property under different
    // internal names; default to the deal's when not given explicitly (matches
    // config/index.js's own fallback for HS_PROPERTY_QUOTE_ODOO_QUOTE_ID).
    this.propertyQuoteOdooQuoteId = propertyQuoteOdooQuoteId || this.propertyOdooQuoteId
    this.propertyQuoteCountry = propertyQuoteCountry || DEFAULT_QUOTE_PROPERTY_NAMES.country
    this.quoteEligibleStatuses = Array.isArray(quoteEligibleStatuses) && quoteEligibleStatuses.length > 0
      ? quoteEligibleStatuses
      : DEFAULT_QUOTE_ELIGIBLE_STATUSES
    this.echoGuard = echoGuard || createEchoGuard({ ttlMs: 10000 })
    this.logger = logger
  }

  async fetchRecord(sourceId) {
    const { dealId, quoteId } = parseSourceId(sourceId)
    const dealProps = buildDealPropertiesToFetch({
      propertyOdooCustomerId: this.propertyOdooCustomerId,
      propertyOdooOrderId: this.propertyOdooOrderId,
      propertyOdooQuoteId: this.propertyOdooQuoteId
    })
    const data = await this.apiClient.getDeal(dealId, dealProps)
    const record = {
      id: sourceId,
      dealId: data.id,
      quoteId: quoteId || null,
      properties: data.properties || {},
      associations: data.associations || {}
    }
    if (quoteId) {
      const quoteProps = buildQuotePropertiesToFetch({
        propertyQuoteCountry: this.propertyQuoteCountry,
        propertyOdooQuoteId: this.propertyQuoteOdooQuoteId
      })
      const quote = await this.apiClient.getQuote(quoteId, quoteProps)
      record.quote = { id: quote.id, properties: quote.properties || {} }
    }
    return record
  }

  async resolveReferences(record) {
    const references = {}
    if (!record || !record.id) return references
    const dealId = record.dealId || record.id
    const quoteId = record.quoteId || null
    try {
      if (quoteId) {
        // quotes do not carry contact/company associations at the deal level
        references.associations = []
      } else {
        const data = await this.apiClient.getDealAssociations(dealId, ['contact', 'company'])
        references.associations = data && data.results ? data.results : []
      }
    } catch (err) {
      this.logger && this.logger.warn('hubspot.resolveReferences.associations failed', { sourceId: record.id, error: err.message })
      references.associations = []
    }
    try {
      if (quoteId && typeof this.apiClient.getQuoteLineItems === 'function') {
        references.lineItems = await this.apiClient.getQuoteLineItems(quoteId)
      } else {
        references.lineItems = await this.apiClient.getDealLineItems(dealId)
      }
    } catch (err) {
      this.logger && this.logger.warn('hubspot.resolveReferences.lineItems failed', { sourceId: record.id, error: err.message })
      references.lineItems = []
    }
    return references
  }

  async writeBack(sourceId, payload = {}) {
    if (!payload || typeof payload !== 'object') return
    const { dealId, quoteId } = parseSourceId(sourceId)
    const properties = {}
    if (payload.id_orden_odoo != null) properties[this.propertyOdooOrderId] = payload.id_orden_odoo
    if (payload.id_cliente_odoo != null) properties[this.propertyOdooCustomerId] = payload.id_cliente_odoo
    if (payload.id_presupuesto_odoo != null) {
      properties[quoteId ? this.propertyQuoteOdooQuoteId : this.propertyOdooQuoteId] = payload.id_presupuesto_odoo
    }
    if (payload.numero_orden_fabricacion != null) {
      properties[this.propertyManufacturingOrder] = payload.numero_orden_fabricacion
    }
    if (payload.estado_presupuesto_odoo != null) {
      properties[this.propertyQuoteState] = payload.estado_presupuesto_odoo
    }
    if (payload.estado_facturacion_odoo != null) {
      properties[this.propertyQuoteInvoiceStatus] = payload.estado_facturacion_odoo
    }
    if (Object.keys(properties).length === 0) return
    const echoKey = `${sourceId}:${JSON.stringify(properties)}`
    if (this.echoGuard.shouldSuppress(echoKey)) {
      if (this.logger) this.logger.debug('hubspot.writeBack suppressed by echo guard', { sourceId, echoKey })
      return
    }
    if (quoteId) {
      await this.apiClient.updateQuote(quoteId, properties)
    } else {
      await this.apiClient.updateDeal(dealId, properties)
    }
    if (this.logger) this.logger.info('hubspot.writeBack', { sourceId, dealId, quoteId, properties })
  }

  async revertDealStage(sourceId) {
    const { dealId } = parseSourceId(sourceId)
    const history = await this.apiClient.getDealStageHistory(dealId)
    const currentStage = Array.isArray(history) && history.length > 0 ? history[0].value : null
    const previousStage = resolvePreviousDealStage(history, currentStage)
    if (!previousStage) {
      if (this.logger) this.logger.warn('hubspot.revertDealStage.no_previous_stage', { sourceId, dealId })
      return
    }
    const echoKey = `revert-stage:${dealId}:${previousStage}`
    if (this.echoGuard.shouldSuppress(echoKey)) {
      if (this.logger) this.logger.debug('hubspot.revertDealStage suppressed by echo guard', { sourceId, echoKey })
      return
    }
    await this.apiClient.updateDeal(dealId, { dealstage: previousStage })
    if (this.logger) this.logger.info('hubspot.revertDealStage', { sourceId, dealId, previousStage })
  }
}

module.exports = {
  HubspotSourceGateway,
  resolvePreviousDealStage,
  DEAL_PROPERTIES_TO_FETCH: DEFAULT_DEAL_PROPERTIES_TO_FETCH,
  buildDealPropertiesToFetch,
  buildQuotePropertiesToFetch,
  parseSourceId,
  isEligibleQuote,
  listEligibleQuotes,
  DEFAULT_QUOTE_ELIGIBLE_STATUSES,
  DEFAULT_QUOTE_PROPERTY_NAMES
}
