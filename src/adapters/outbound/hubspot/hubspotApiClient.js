'use strict'

const axios = require('axios')

const LINE_ITEM_PROPERTIES = ['hs_sku', 'quantity', 'price', 'name']

function createAxiosHttpClient({ baseUrl, accessToken, timeoutMs = 10000 } = {}) {
  return axios.create({
    baseURL: baseUrl,
    timeout: timeoutMs,
    headers: { Authorization: `Bearer ${accessToken}` }
  })
}

function createHubspotApiClient({ baseUrl, accessToken, timeoutMs = 10000, httpClient = null } = {}) {
  if (!accessToken) throw new Error('createHubspotApiClient requires accessToken')
  const http = httpClient || createAxiosHttpClient({ baseUrl, accessToken, timeoutMs })

  async function getDeal(dealId, properties = []) {
    const res = await http.get(`/crm/v3/objects/deals/${dealId}`, {
      params: properties.length > 0 ? { properties: properties.join(',') } : undefined
    })
    return res.data
  }

  async function getDealAssociations(dealId, toObjectType = ['contact', 'company']) {
    const res = await http.get(`/crm/v4/objects/deals/${dealId}/associations/${toObjectType.join(',')}`)
    return res.data
  }

  async function getDealLineItems(dealId) {
    if (!dealId) return []
    const assoc = await http.get(`/crm/v3/objects/deals/${dealId}/associations/line_items`)
    const ids = (assoc.data && assoc.data.results ? assoc.data.results : [])
      .map((r) => r.id || r.toObjectId || r['to-object-id'])
      .filter(Boolean)
    if (ids.length === 0) return []
    const batch = await http.post('/crm/v3/objects/line_items/batch/read', {
      properties: LINE_ITEM_PROPERTIES,
      inputs: ids.map((id) => ({ id: String(id) }))
    })
    const results = (batch.data && batch.data.results ? batch.data.results : [])
    return results.map((li) => ({
      id: li.id,
      hs_sku: (li.properties && li.properties.hs_sku) || null,
      quantity: Number(li.properties && li.properties.quantity) || 1,
      price: Number(li.properties && li.properties.price) || 0,
      name: (li.properties && li.properties.name) || null
    }))
  }

  async function updateDeal(dealId, properties) {
    const res = await http.patch(`/crm/v3/objects/deals/${dealId}`, { properties })
    return res.data
  }

  async function searchProductByHsSku(sku) {
    if (!sku || String(sku).length === 0) return null
    const res = await http.post('/crm/v3/objects/products/search', {
      filterGroups: [{ filters: [{ propertyName: 'hs_sku', operator: 'EQ', value: String(sku) }] }],
      properties: ['hs_sku', 'name', 'price'],
      limit: 1
    })
    const items = (res.data && res.data.results) || []
    return items[0] || null
  }

  async function createProduct(properties) {
    const res = await http.post('/crm/v3/objects/products', { properties })
    return res.data
  }

  async function updateProduct(productId, properties) {
    const res = await http.patch(`/crm/v3/objects/products/${productId}`, { properties })
    return res.data
  }

  return {
    getDeal, getDealAssociations, getDealLineItems, updateDeal,
    searchProductByHsSku, createProduct, updateProduct,
    _http: http
  }
}

module.exports = { createHubspotApiClient, createAxiosHttpClient, LINE_ITEM_PROPERTIES }
