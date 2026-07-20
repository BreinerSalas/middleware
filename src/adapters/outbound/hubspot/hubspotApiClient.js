'use strict'

const axios = require('axios')

function createHubspotApiClient({ baseUrl, accessToken, timeoutMs = 10000 } = {}) {
  if (!accessToken) throw new Error('createHubspotApiClient requires accessToken')
  const client = axios.create({
    baseURL: baseUrl,
    timeout: timeoutMs,
    headers: { Authorization: `Bearer ${accessToken}` }
  })

  async function getDeal(dealId, properties = []) {
    const res = await client.get(`/crm/v3/objects/deals/${dealId}`, {
      params: properties.length > 0 ? { properties: properties.join(',') } : undefined
    })
    return res.data
  }

  async function getDealAssociations(dealId, toObjectType = ['contact', 'company']) {
    const res = await client.get(`/crm/v4/objects/deals/${dealId}/associations/${toObjectType.join(',')}`)
    return res.data
  }

  async function updateDeal(dealId, properties) {
    const res = await client.patch(`/crm/v3/objects/deals/${dealId}`, { properties })
    return res.data
  }

  return { getDeal, getDealAssociations, updateDeal, _client: client }
}

module.exports = { createHubspotApiClient }
