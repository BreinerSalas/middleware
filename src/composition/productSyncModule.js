'use strict'

const async = require('async')

function createProductSyncModule({ config = {}, odooSource, hubspotGateway, logger = null, concurrency = 10 } = {}) {
  if (!odooSource) throw new Error('createProductSyncModule requires odooSource')
  if (!hubspotGateway) throw new Error('createProductSyncModule requires hubspotGateway')

  const log = (level, msg, extra) => { if (logger && typeof logger[level] === 'function') logger[level](msg, extra) }

  async function syncOneItem(odooProduct, { dryRun } = {}) {
    if (dryRun) {
      return { id: odooProduct.id, sku: odooProduct.default_code, dryRun: true, created: false, skipped: true }
    }
    return hubspotGateway.upsertBySku(odooProduct)
  }

  async function runOnce({ limit = null, dryRun = false } = {}) {
    const total = await odooSource.count()
    log('info', 'product-sync.start', { total, limit, dryRun })
    const opts = {}
    if (limit != null) opts.limit = limit
    const products = await odooSource.listAll(opts)

    const results = await async.mapLimit(products, concurrency, async (p) => {
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

    const succeeded = results.filter((r) => !r.failed && !r.dryRun && !r.skipped)
    const created = results.filter((r) => r.created === true).length
    const updated = results.filter((r) => r.created === false && !r.failed && !r.dryRun && !r.skipped).length
    const failed = results.filter((r) => r.failed).length
    const skipped = results.filter((r) => r.skipped).length

    log('info', 'product-sync.done', {
      total, count: results.length, succeeded: succeeded.length, created, updated, failed, skipped
    })

    return results
  }

  return { runOnce, syncOneItem }
}

module.exports = { createProductSyncModule }
