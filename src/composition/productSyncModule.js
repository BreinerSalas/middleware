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
    const chunks = chunk(odooProducts, chunkSize)
    log('info', 'product-sync.batch.started', { chunkSize, chunks: chunks.length, items: odooProducts.length, dryRun })

    for (let i = 0; i < chunks.length; i += 1) {
      const c = chunks[i]
      try {
        if (dryRun) {
          for (const p of c) results.push({ sourceId: p.id, sku: p.default_code, ...dryRunItem(p) })
          continue
        }
        const r = await hubspotGateway.batchUpsertBySkus(c, { chunkSize: c.length })
        const bySku = new Map()
        for (const item of r.results || []) {
          const sku = item.properties && item.properties.hs_sku
          if (sku) bySku.set(sku, item)
        }
        for (const errItem of r.errors || []) {
          log('error', 'product-sync.item.failed', { sku: errItem.id, error: errItem.message, category: errItem.category })
          results.push({ sourceId: null, sku: errItem.id, failed: true, error: errItem.message })
        }
        for (const p of c) {
          const sku = String(p.default_code).trim()
          const hub = bySku.get(sku)
          if (hub) {
            results.push({ sourceId: p.id, sku, id: hub.id, created: Boolean(hub.createdAt && hub.createdAt === hub.updatedAt), hubspotId: hub.id })
          } else if (!(r.errors || []).some((e) => e.id === sku)) {
            results.push({ sourceId: p.id, sku, failed: true, error: 'not_in_batch_response' })
          }
        }
        log('info', 'product-sync.batch.chunk.completed', { chunkIndex: i + 1, items: c.length, results: r.results.length, errors: r.errors.length })
      } catch (err) {
        for (const p of c) results.push({ sourceId: p.id, sku: p.default_code, failed: true, error: err.message })
        log('error', 'product-sync.chunk.failed', { chunkIndex: i + 1, items: c.length, error: err.message })
      }
    }
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
