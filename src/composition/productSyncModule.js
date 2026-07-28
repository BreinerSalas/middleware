'use strict'

const async = require('async')

function createProductSyncModule({
  config = {},
  odooSource,
  hubspotGateway,
  logger = null,
  concurrency = 10,
  chunkSize = 100
} = {}) {
  if (!odooSource) throw new Error('createProductSyncModule requires odooSource')
  if (!hubspotGateway) throw new Error('createProductSyncModule requires hubspotGateway')

  const log = (level, msg, extra) => { if (logger && typeof logger[level] === 'function') logger[level](msg, extra) }

  function dryRunItem(odooProduct) {
    return { id: odooProduct.id, sku: odooProduct.default_code, dryRun: true, created: false, skipped: true }
  }

  async function syncOneItem(odooProduct, { dryRun } = {}) {
    if (dryRun) return dryRunItem(odooProduct)
    return hubspotGateway.upsertBySku(odooProduct)
  }

  function partition(products) {
    const withSku = []
    const withoutSku = []
    for (const p of products) {
      const sku = p && p.default_code
      if (sku != null && sku !== false && String(sku).trim() !== '') withSku.push(p)
      else withoutSku.push(p)
    }
    return { withSku, withoutSku }
  }

  function chunk(arr, size) {
    const out = []
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
    return out
  }

  async function runBatchForOdooItems(odooProducts, { dryRun }) {
    const results = []
    log('info', 'product-sync.batch.started', { chunkSize, items: odooProducts.length, dryRun })
    if (dryRun) {
      for (const p of odooProducts) results.push({ sourceId: p.id, sku: p.default_code, ...dryRunItem(p) })
      return results
    }
    let batchSummary
    try {
      batchSummary = await hubspotGateway.batchUpsertBySkus(odooProducts, { chunkSize })
    } catch (err) {
      for (const p of odooProducts) results.push({ sourceId: p.id, sku: p.default_code, failed: true, error: err.message })
      log('error', 'product-sync.chunk.failed', { items: odooProducts.length, error: err.message })
      return results
    }
    const sentMap = new Map()
    for (const p of odooProducts) sentMap.set(this ? null : null, p)
    const skuToOdooIds = new Map()
    for (const p of odooProducts) {
      const sku = String(p.default_code || '').trim()
      if (!sku) continue
      if (!skuToOdooIds.has(sku)) skuToOdooIds.set(sku, [])
      skuToOdooIds.get(sku).push(p.id)
    }
    const seenInBatch = new Set()
    for (const item of batchSummary.results || []) {
      const sku = item.properties && item.properties.hs_sku
      if (sku) seenInBatch.add(sku)
      const isNew = item.new === true || (item.createdAt && item.createdAt === item.updatedAt)
      const odooIds = (sku && skuToOdooIds.get(sku)) || []
      if (odooIds.length > 0) {
        results.push({ sourceId: odooIds[0], sku, id: item.id, created: Boolean(isNew), hubspotId: item.id })
      }
      for (let i = 1; i < odooIds.length; i += 1) {
        results.push({ sourceId: odooIds[i], sku, skipped: true, reason: 'duplicate_sku_in_odoo' })
      }
    }
    for (const errItem of batchSummary.errors || []) {
      log('error', 'product-sync.item.failed', { sku: errItem.id, error: errItem.message, category: errItem.category })
      const odooIds = skuToOdooIds.get(errItem.id) || []
      for (const oid of odooIds) results.push({ sourceId: oid, sku: errItem.id, failed: true, error: errItem.message })
    }
    for (const [sku, odooIds] of skuToOdooIds.entries()) {
      if (seenInBatch.has(sku)) continue
      if ((batchSummary.errors || []).some((e) => e.id === sku)) continue
      const skipped = odooIds.length > 1 ? odooIds.slice(1) : []
      results.push({ sourceId: odooIds[0], sku, assumed: 'updated' })
      for (const oid of skipped) results.push({ sourceId: oid, sku, skipped: true, reason: 'duplicate_sku_in_odoo' })
    }
    log('info', 'product-sync.batch.summary', {
      chunks: Math.ceil(odooProducts.length / chunkSize),
      items: odooProducts.length,
      uniqueSkus: skuToOdooIds.size,
      results: (batchSummary.results || []).length,
      errors: (batchSummary.errors || []).length,
      duplicatesSkipped: (batchSummary.skipped || []).length
    })
    return results
  }

  async function runOnce({ limit = null, dryRun = false, includeNoSku = false } = {}) {
    const total = await odooSource.count({ includeNoSku })
    log('info', 'product-sync.start', { total, limit, dryRun, includeNoSku })
    const opts = { includeNoSku }
    if (limit != null) opts.limit = limit
    const products = await odooSource.listAll(opts)

    const { withSku, withoutSku } = partition(products)

    const batchResults = await runBatchForOdooItems(withSku, { dryRun })

    const singleResults = await async.mapLimit(withoutSku, Math.max(1, Math.min(3, concurrency)), async (p) => {
      try {
        const r = await syncOneItem(p, { dryRun })
        return { sourceId: p.id, sku: p.default_code, ...r }
      } catch (err) {
        if (logger && typeof logger.error === 'function') {
          logger.error('product-sync.item.failed', { sourceId: p.id, sku: p.default_code, error: err.message })
        }
        return { sourceId: p.id, sku: p.default_code, failed: true, error: err.message }
      }
    })

    const results = [...batchResults, ...singleResults]

    const succeeded = results.filter((r) => !r.failed && !r.dryRun && !r.skipped)
    const created = results.filter((r) => r.created === true).length
    const updated = results.filter((r) => r.created === false && !r.failed && !r.dryRun && !r.skipped).length
    const failed = results.filter((r) => r.failed).length
    const skipped = results.filter((r) => r.skipped).length

    log('info', 'product-sync.done', {
      total, count: results.length, succeeded: succeeded.length, created, updated, failed, skipped, dryRun
    })

    return results
  }

  return { runOnce, syncOneItem }
}

module.exports = { createProductSyncModule }
