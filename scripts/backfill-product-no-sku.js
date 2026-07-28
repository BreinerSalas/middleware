#!/usr/bin/env node
'use strict'

/**
 * Backfill product_mapping records for Odoo no-sku products.
 *
 * Fast version:
 *   1. Page through ALL HubSpot products with hs_sku = NULL (paginated search).
 *   2. Load all Odoo no-sku products.
 *   3. Build in-memory map: name -> [hubspot products].
 *   4. For each Odoo no-sku, lookup by name; take first candidate; persist
 *      a ProductMapping record (or no_sku_no_match if no candidate).
 *   5. Single bulkWrite to Mongo.
 *
 * Total HubSpot API calls: ~50 (paginated). Mongo writes: 1.
 * Total runtime: ~30 seconds (mostly waiting for HubSpot paginated search).
 */

const path = require('node:path')
const { load } = require('../src/config')
const { createLogger } = require('../src/lib/logger')
const { connectMongo, disconnectMongo } = require('../src/adapters/outbound/mongo/connection')
const { createOdooApiClient } = require('../src/adapters/outbound/odoo/odooApiClient')
const { createHubspotApiClient } = require('../src/adapters/outbound/hubspot/hubspotApiClient')
const { OdooProductSource } = require('../src/adapters/outbound/odoo/OdooProductSource')
const { MongoProductMappingRepository } = require('../src/adapters/outbound/mongo/MongoProductMappingRepository')

async function fetchAllHubspotNoSkuInBatches(api) {
  const all = []
  let after
  let page = 0
  while (true) {
    const res = await api.searchProducts({
      filterGroups: [{ filters: [{ propertyName: 'hs_sku', operator: 'NOT_HAS_PROPERTY' }] }],
      properties: ['hs_object_id', 'name'],
      limit: 100,
      after
    })
    all.push(...(res.results || []))
    page += 1
    if (!res.paging || !res.paging.next) break
    after = res.paging.next.after
  }
  return { items: all, pages: page }
}

async function loadOdooNoSku(source) {
  const all = await source.listAll({ includeNoSku: true })
  return all.filter((p) => !p.default_code || p.default_code === false || String(p.default_code || '').trim() === '')
}

async function main() {
  const envFile = path.resolve(process.env.SMARTFLOW_ENV_FILE || '.env.staging')
  const cfg = load({ envFile })
  const logger = createLogger({ level: cfg.logging.level })
  await connectMongo({ uri: cfg.mongodbUri, logger })

  const odooApi = createOdooApiClient({
    mode: cfg.odoo.mode, baseUrl: cfg.odoo.baseUrl, db: cfg.odoo.db,
    login: cfg.odoo.login, apiKey: cfg.odoo.apiKey
  })
  const hubspotApi = createHubspotApiClient({
    baseUrl: cfg.hubspot.apiBase, accessToken: cfg.hubspot.accessToken
  })
  const source = new OdooProductSource({ apiClient: odooApi })
  const mappingRepo = new MongoProductMappingRepository()

  logger.info('backfill.start', { envFile })

  const t0 = Date.now()
  const { items: hubspotNoSku, pages } = await fetchAllHubspotNoSkuInBatches(hubspotApi)
  logger.info('backfill.hubspot_loaded', { count: hubspotNoSku.length, pages, ms: Date.now() - t0 })

  const byName = new Map()
  let unnamedHubspot = 0
  for (const h of hubspotNoSku) {
    const name = (h.properties && h.properties.name) || ''
    if (!name) { unnamedHubspot += 1; continue }
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push(h)
  }
  logger.info('backfill.indexed', { uniqueNames: byName.size, unnamedHubspot })

  const odooNoSku = await loadOdooNoSku(source)
  logger.info('backfill.odoo_loaded', { count: odooNoSku.length })

  let matched = 0, ambiguous = 0, notFound = 0
  const mappingItems = []
  for (const p of odooNoSku) {
    const candidates = byName.get(p.name)
    if (!candidates || candidates.length === 0) {
      notFound += 1
      mappingItems.push({
        odooId: Number(p.id),
        hsSku: null,
        hubspotId: null,
        action: 'no_sku_no_match',
        metadata: { name: p.name, list_price: p.list_price }
      })
    } else {
      matched += 1
      if (candidates.length > 1) {
        ambiguous += 1
      }
      const first = candidates.shift()
      mappingItems.push({
        odooId: Number(p.id),
        hsSku: null,
        hubspotId: String(first.id),
        action: 'backfilled',
        metadata: { name: p.name, list_price: p.list_price, candidates: candidates.length + 1 }
      })
    }
  }

  let writeResult
  try {
    writeResult = await mappingRepo.bulkUpsertMany({ items: mappingItems })
  } catch (err) {
    logger.error('backfill.mongo_write_failed', { error: err.message })
    await disconnectMongo({ logger })
    process.exit(1)
  }

  logger.info('backfill.done', {
    odooNoSku: odooNoSku.length,
    mappingsWritten: mappingItems.length,
    matched,
    notFound,
    ambiguous,
    write: writeResult,
    totalMs: Date.now() - t0
  })

  await disconnectMongo({ logger })
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({ level: 'error', msg: 'backfill.fatal', error: err.message, stack: err.stack }) + '\n')
    process.exit(1)
  })
}

module.exports = { main, fetchAllHubspotNoSkuInBatches, loadOdooNoSku }
