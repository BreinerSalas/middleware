'use strict'

const axios = require('axios')

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

  async function updateDeal(dealId, properties) {
    const res = await http.patch(`/crm/v3/objects/deals/${dealId}`, { properties })
    return res.data
  }

  return { getDeal, getDealAssociations, updateDeal, _http: http }
}

module.exports = { createHubspotApiClient, createAxiosHttpClient }
