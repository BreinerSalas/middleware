'use strict'

const axios = require('axios')
const { createRateLimiter } = require('../../../core/shared/rateLimiter')

const LINE_ITEM_PROPERTIES = ['hs_sku', 'quantity', 'price', 'name', 'hs_product_id']

const QUOTE_PROPERTIES = [
  'hs_status',
  'hs_title',
  'hs_currency',
  'hs_quote_amount',
  'pais_de_destino',
  'id_presupuesto_odoo',
  'numero_orden_fabricacion',
  'estado_presupuesto_odoo',
  'estado_facturacion_odoo'
]

function createAxiosHttpClient({ baseUrl, accessToken, timeoutMs = 10000 } = {}) {
  return axios.create({
    baseURL: baseUrl,
    timeout: timeoutMs,
    headers: { Authorization: `Bearer ${accessToken}` }
  })
}

function parseRetryAfterMs(headers, errFallback = 1000) {
  if (!headers) return errFallback
  const raw = headers['retry-after'] || headers['Retry-After'] || headers['x-hubspot-ratelimit-reset-milliseconds']
  if (raw == null) return errFallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return errFallback
  if (n > 1e12) return Math.max(0, n - Date.now())
  return Math.floor(n * 1000)
}

function shouldRetryOn429(err) {
  if (!err) return false
  const status = err.response && err.response.status
  return status === 429
}

function createHubspotApiClient({
  baseUrl,
  accessToken,
  timeoutMs = 10000,
  httpClient = null,
  rateLimiter = undefined,
  maxRetries = 3,
  retryDefaultMs = 1000
} = {}) {
  if (!accessToken) throw new Error('createHubspotApiClient requires accessToken')
  const http = httpClient || createAxiosHttpClient({ baseUrl, accessToken, timeoutMs })
  // Observed real per-token limits for this app (X-HubSpot-RateLimit-* headers, 2026-08-10):
  // secondly=19, max=190 per 10s interval. Set below that ceiling to leave headroom for
  // other concurrent flows (deal webhook, quotes) sharing the same token.
  const rl = rateLimiter === undefined ? createRateLimiter({ rps: 15, burst: 20 }) : rateLimiter

  async function requestWithRateLimit(verb, url, opts = {}) {
    let attempt = 0
    let lastErr = null
    while (attempt <= maxRetries) {
      if (rl) await rl.take()
      try {
        const res = await http[verb](url, opts)
        return res.data
      } catch (err) {
        lastErr = err
        if (!shouldRetryOn429(err) || attempt === maxRetries) {
          throw err
        }
        const waitMs = parseRetryAfterMs(err.response && err.response.headers, retryDefaultMs)
        if (rl && typeof rl.pause === 'function') rl.pause(waitMs)
        else await new Promise((r) => setTimeout(r, waitMs))
        attempt += 1
      }
    }
    throw lastErr
  }

  function normalizeHubspotError(err) {
    if (!err) return err
    const status = err.response && err.response.status
    const body = err.response && err.response.data
    const hubMsg = body && (body.message || body.error || body)
    if (status && hubMsg) {
      const msg = typeof hubMsg === 'string' ? hubMsg : JSON.stringify(hubMsg)
      const newErr = new Error(msg)
      newErr.httpStatus = status
      newErr.original = err
      return newErr
    }
    return err
  }

  async function getDeal(dealId, properties = []) {
    try {
      return await requestWithRateLimit('get', `/crm/v3/objects/deals/${dealId}`, {
        params: properties.length > 0 ? { properties: properties.join(',') } : undefined
      })
    } catch (err) { throw normalizeHubspotError(err) }
  }

  async function getDealStageHistory(dealId) {
    try {
      const data = await requestWithRateLimit('get', `/crm/v3/objects/deals/${dealId}`, {
        params: { propertiesWithHistory: 'dealstage' }
      })
      return (data && data.propertiesWithHistory && data.propertiesWithHistory.dealstage) || []
    } catch (err) { throw normalizeHubspotError(err) }
  }

  async function getDealAssociations(dealId, toObjectType = ['contact', 'company']) {
    try {
      return await requestWithRateLimit('get', `/crm/v4/objects/deals/${dealId}/associations/${toObjectType.join(',')}`)
    } catch (err) { throw normalizeHubspotError(err) }
  }

  async function getLineItemsFor(objectType, objectId) {
    if (!objectId) return []
    const url = `/crm/v3/objects/${objectType}/${objectId}/associations/line_items`
    let assoc
    try {
      assoc = await requestWithRateLimit('get', url)
    } catch (err) { throw normalizeHubspotError(err) }
    const ids = (assoc.results ? assoc.results : [])
      .map((r) => r.id || r.toObjectId || r['to-object-id'])
      .filter(Boolean)
    if (ids.length === 0) return []
    let batch
    try {
      batch = await requestWithRateLimit('post', '/crm/v3/objects/line_items/batch/read', {
        properties: LINE_ITEM_PROPERTIES,
        inputs: ids.map((id) => ({ id: String(id) }))
      })
    } catch (err) { throw normalizeHubspotError(err) }
    const results = (batch.results ? batch.results : [])
    return results.map((li) => ({
      id: li.id,
      hs_sku: (li.properties && li.properties.hs_sku) || null,
      quantity: Number(li.properties && li.properties.quantity) || 1,
      price: Number(li.properties && li.properties.price) || 0,
      name: (li.properties && li.properties.name) || null,
      hs_product_id: (li.properties && li.properties.hs_product_id) || null
    }))
  }

  async function getDealLineItems(dealId) {
    return getLineItemsFor('deals', dealId)
  }

  async function getQuoteLineItems(quoteId) {
    return getLineItemsFor('quotes', quoteId)
  }

  async function getQuote(quoteId, properties = []) {
    try {
      return await requestWithRateLimit('get', `/crm/v3/objects/quotes/${quoteId}`, {
        params: properties.length > 0 ? { properties: properties.join(',') } : undefined
      })
    } catch (err) { throw normalizeHubspotError(err) }
  }

  async function updateQuote(quoteId, properties) {
    try {
      return await requestWithRateLimit('patch', `/crm/v3/objects/quotes/${quoteId}`, { properties })
    } catch (err) { throw normalizeHubspotError(err) }
  }

  async function getDealQuotes(dealId, properties = QUOTE_PROPERTIES) {
    if (!dealId) return []
    let assoc
    try {
      assoc = await requestWithRateLimit('get', `/crm/v3/objects/deals/${dealId}/associations/quotes`)
    } catch (err) { throw normalizeHubspotError(err) }
    const ids = (assoc.results ? assoc.results : [])
      .map((r) => r.id || r.toObjectId || r['to-object-id'])
      .filter(Boolean)
    if (ids.length === 0) return []
    let batch
    try {
      batch = await requestWithRateLimit('post', '/crm/v3/objects/quotes/batch/read', {
        properties: Array.isArray(properties) ? properties : QUOTE_PROPERTIES,
        inputs: ids.map((id) => ({ id: String(id) }))
      })
    } catch (err) { throw normalizeHubspotError(err) }
    const results = (batch.results ? batch.results : [])
    return results.map((q) => ({
      id: q.id,
      properties: q.properties || {}
    }))
  }

  async function updateDeal(dealId, properties) {
    try {
      return await requestWithRateLimit('patch', `/crm/v3/objects/deals/${dealId}`, { properties })
    } catch (err) { throw normalizeHubspotError(err) }
  }

  async function searchProductByOdooId(odooId) {
    if (odooId == null || String(odooId).length === 0) return null
    try {
      const data = await requestWithRateLimit('post', '/crm/v3/objects/products/search', {
        filterGroups: [{ filters: [{ propertyName: 'id_producto_odoo', operator: 'EQ', value: String(odooId) }] }],
        properties: ['id_producto_odoo', 'name', 'price'],
        limit: 1
      })
      const items = (data && data.results) || []
      return items[0] || null
    } catch (err) { throw normalizeHubspotError(err) }
  }

  async function createProduct(properties) {
    try {
      return await requestWithRateLimit('post', '/crm/v3/objects/products', { properties })
    } catch (err) { throw normalizeHubspotError(err) }
  }

  async function updateProduct(productId, properties) {
    try {
      return await requestWithRateLimit('patch', `/crm/v3/objects/products/${productId}`, { properties })
    } catch (err) { throw normalizeHubspotError(err) }
  }

  async function batchUpsertProducts({ inputs = [], idProperty = 'id_producto_odoo' } = {}) {
    const taggedInputs = inputs.map((it) => ({ ...it, idProperty: it.idProperty || idProperty }))
    let data
    try {
      data = await requestWithRateLimit('post', '/crm/v3/objects/products/batch/upsert', {
        inputs: taggedInputs
      })
    } catch (err) { throw normalizeHubspotError(err) }
    const rawResults = (data && data.results) || []
    const results = []
    const errors = []
    for (const item of rawResults) {
      if (item && item.status === 'error') {
        const ctx = item.context || {}
        const idFromCtx = (ctx.id && Array.isArray(ctx.id) && ctx.id[0]) || ctx.input || null
        errors.push({
          id: idFromCtx,
          message: item.message || (item.errors && item.errors[0] && item.errors[0].message) || 'unknown',
          category: item.category || null,
          raw: item
        })
      } else if (item && item.id) {
        results.push(item)
      }
    }
    return { results, errors, numErrors: typeof data.numErrors === 'number' ? data.numErrors : errors.length }
  }

  // (openspec/hubspot-product-odoo-id-key, post-verify fix) `/products/batch/upsert` REQUIRES
  // idProperty on every input — HubSpot rejects the request otherwise ("Upserts in a single
  // batch must specify its unique property using idProperty"). Writing onto a product by its
  // already-known native HubSpot object id (the backfill's use case) needs the separate
  // batch/update endpoint instead, which always matches by native id and takes no idProperty.
  async function batchUpdateProducts({ inputs = [] } = {}) {
    let data
    try {
      data = await requestWithRateLimit('post', '/crm/v3/objects/products/batch/update', { inputs })
    } catch (err) { throw normalizeHubspotError(err) }
    const rawResults = (data && data.results) || []
    const rawErrors = (data && data.errors) || []
    const results = []
    const errors = []
    for (const item of rawResults) {
      if (item && item.status === 'error') {
        const ctx = item.context || {}
        const idFromCtx = (ctx.id && Array.isArray(ctx.id) && ctx.id[0]) || ctx.input || null
        errors.push({
          id: idFromCtx,
          message: item.message || (item.errors && item.errors[0] && item.errors[0].message) || 'unknown',
          category: item.category || null,
          raw: item
        })
      } else if (item && item.id) {
        results.push(item)
      }
    }
    for (const item of rawErrors) errors.push(item)
    return { results, errors, numErrors: typeof (data && data.numErrors) === 'number' ? data.numErrors : errors.length }
  }

  // (sdd/hubspot-product-reverse-discovery, design D2) Track B archives a duplicate
  // HubSpot product via HubSpot's own soft-delete (recycle bin, restorable) instead of a
  // hard DELETE. The endpoint returns an empty body on 204 success — do not treat that as
  // a missing/invalid response.
  async function batchArchiveProducts({ inputs = [] } = {}) {
    if (inputs.length === 0) return { archived: 0, errors: [] }
    let data
    try {
      data = await requestWithRateLimit('post', '/crm/v3/objects/products/batch/archive', { inputs })
    } catch (err) { throw normalizeHubspotError(err) }
    const rawErrors = (data && data.errors) || []
    return { archived: inputs.length - rawErrors.length, errors: rawErrors }
  }

  // (sdd/hubspot-product-reverse-discovery, design D3) Referenced-orphan check ahead of a
  // Track B archive: any existing deal/quote line item pointing at this product blocks the
  // archive. `limit: 1` keeps the call bounded — only `total` matters, not the row itself.
  async function searchLineItemsByProductId(productId) {
    let data
    try {
      data = await requestWithRateLimit('post', '/crm/v3/objects/line_items/search', {
        filterGroups: [{ filters: [{ propertyName: 'hs_product_id', operator: 'EQ', value: String(productId) }] }],
        limit: 1
      })
    } catch (err) { throw normalizeHubspotError(err) }
    return { total: (data && data.total) || 0, results: (data && data.results) || [] }
  }

  async function getCustomProperty(objectType, name) {
    try {
      const res = await requestWithRateLimit('get', `/crm/v3/properties/${objectType}/${name}`)
      return res
    } catch (err) { throw normalizeHubspotError(err) }
  }

  async function createCustomProperty(objectType, body) {
    try {
      return await requestWithRateLimit('post', `/crm/v3/properties/${objectType}`, body)
    } catch (err) { throw normalizeHubspotError(err) }
  }

  async function updateCustomProperty(objectType, name, body) {
    try {
      return await requestWithRateLimit('patch', `/crm/v3/properties/${objectType}/${name}`, body)
    } catch (err) { throw normalizeHubspotError(err) }
  }

  async function searchProducts({ filterGroups = [], properties = [], limit = 100, after = null, sorts = null } = {}) {
    const body = { filterGroups, properties, limit }
    if (after) body.after = after
    // Deep-paging without an explicit sort can skip or repeat records — see
    // docs/todo-sku-sintetico.md. Callers paginating past a single page should pass sorts.
    if (Array.isArray(sorts) && sorts.length > 0) body.sorts = sorts
    try {
      return await requestWithRateLimit('post', '/crm/v3/objects/products/search', body)
    } catch (err) { throw normalizeHubspotError(err) }
  }

  async function searchContactByProperty(propertyName, value) {
    if (value == null || String(value).length === 0) return null
    let data
    try {
      data = await requestWithRateLimit('post', '/crm/v3/objects/contacts/search', {
        filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value: String(value) }] }],
        properties: [propertyName, 'firstname', 'lastname', 'email'],
        limit: 1
      })
    } catch (err) { throw normalizeHubspotError(err) }
    const items = (data && data.results) || []
    return items[0] || null
  }

  async function createContact(properties) {
    try {
      return await requestWithRateLimit('post', '/crm/v3/objects/contacts', { properties })
    } catch (err) { throw normalizeHubspotError(err) }
  }

  async function updateContact(contactId, properties) {
    try {
      return await requestWithRateLimit('patch', `/crm/v3/objects/contacts/${contactId}`, { properties })
    } catch (err) { throw normalizeHubspotError(err) }
  }

  async function batchUpsertContacts({ inputs = [], idProperty = 'id_contacto_odoo' } = {}) {
    const taggedInputs = inputs.map((it) => ({ ...it, idProperty: it.idProperty || idProperty }))
    let data
    try {
      data = await requestWithRateLimit('post', '/crm/v3/objects/contacts/batch/upsert', {
        inputs: taggedInputs
      })
    } catch (err) { throw normalizeHubspotError(err) }
    const rawResults = (data && data.results) || []
    const results = []
    const errors = []
    for (const item of rawResults) {
      if (item && item.status === 'error') {
        const ctx = item.context || {}
        const idFromCtx = (ctx.id && Array.isArray(ctx.id) && ctx.id[0]) || ctx.input || null
        errors.push({
          id: idFromCtx,
          message: item.message || (item.errors && item.errors[0] && item.errors[0].message) || 'unknown',
          category: item.category || null,
          raw: item
        })
      } else if (item && item.id) {
        results.push(item)
      }
    }
    return { results, errors, numErrors: typeof data.numErrors === 'number' ? data.numErrors : errors.length }
  }

  async function ensureCustomProperty(objectType, name, body) {
    try {
      await getCustomProperty(objectType, name)
      return { created: false }
    } catch (err) {
      if (err.httpStatus === 404) {
        await createCustomProperty(objectType, body)
        return { created: true }
      }
      throw err
    }
  }

  return {
    getDeal, getDealStageHistory, getDealAssociations, getDealLineItems, updateDeal,
    getLineItemsFor, getQuote, getQuoteLineItems, getDealQuotes, updateQuote,
    searchProductByOdooId, createProduct, updateProduct,
    batchUpsertProducts, batchUpdateProducts, batchArchiveProducts,
    searchProducts, searchLineItemsByProductId,
    searchContactByProperty, createContact, updateContact, batchUpsertContacts,
    getCustomProperty, createCustomProperty, updateCustomProperty, ensureCustomProperty,
    _http: http,
    _rateLimiter: rl
  }
}

module.exports = {
  createHubspotApiClient,
  createAxiosHttpClient,
  LINE_ITEM_PROPERTIES,
  QUOTE_PROPERTIES,
  parseRetryAfterMs,
  shouldRetryOn429
}
