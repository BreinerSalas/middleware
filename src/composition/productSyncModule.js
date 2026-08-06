'use strict'

const async = require('async')
const { parseOdooDateUtc, formatOdooDateUtc } = require('../core/shared/odooDate')

const DEFAULT_OVERLAP_MS = 60 * 1000
const EPOCH_WATERMARK = '1970-01-01 00:00:00'
const DEFAULT_CURSOR_KEY = 'product-sync'

function createProductSyncModule({
  config = {},
  odooSource,
  hubspotGateway,
  logger = null,
  concurrency = 10,
  chunkSize = 100,
  mappingRepo = null,
  runRepo = null,
  cursorRepo = null
} = {}) {
  if (!odooSource) throw new Error('createProductSyncModule requires odooSource')
  if (!hubspotGateway) throw new Error('createProductSyncModule requires hubspotGateway')

  function clampConcurrency(n) {
    const v = Math.max(1, Number(n) || 10)
    return Math.min(v, 3)
  }
  const singleConcurrency = clampConcurrency(concurrency)

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
        results.push({
          sourceId: odooIds[0],
          sku,
          id: item.id,
          created: Boolean(isNew),
          action: isNew ? 'created' : 'updated',
          hubspotId: item.id
        })
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

  async function syncSingleItems(products, { dryRun }) {
    return async.mapLimit(products, Math.max(1, Math.min(3, singleConcurrency)), async (p) => {
      try {
        const r = await syncOneItem(p, { dryRun })
        const out = { sourceId: p.id, sku: p.default_code, ...r }
        if (r && r.id && !r.skipped && !r.failed && !dryRun) {
          out.action = r.created === true ? 'created' : 'updated'
          out.hubspotId = r.id
        }
        return out
      } catch (err) {
        if (logger && typeof logger.error === 'function') {
          logger.error('product-sync.item.failed', { sourceId: p.id, sku: p.default_code, error: err.message })
        }
        return { sourceId: p.id, sku: p.default_code, failed: true, error: err.message }
      }
    })
  }

  async function persistMappings(results) {
    if (!mappingRepo) return
    const toPersist = results
      .filter((r) => r.hubspotId && r.sourceId && !r.failed && !r.dryRun && !r.skipped)
      .map((r) => ({
        odooId: r.sourceId,
        hsSku: r.sku == null ? null : String(r.sku),
        hubspotId: r.hubspotId,
        action: r.action || (r.created ? 'created' : 'updated')
      }))
      .filter((m) => m.hsSku && m.hsSku !== 'null' && m.hsSku !== 'false')
    if (toPersist.length === 0) return
    try {
      await mappingRepo.bulkUpsertMany({ items: toPersist })
    } catch (err) {
      log('error', 'product-sync.mappingRepo.bulkUpsertMany failed', { error: err.message, count: toPersist.length })
    }
  }

  async function runOnce({ limit = null, dryRun = false, includeNoSku = false } = {}) {
    const total = await odooSource.count({ includeNoSku })
    log('info', 'product-sync.start', { total, limit, dryRun, includeNoSku })
    const opts = { includeNoSku }
    if (limit != null) opts.limit = limit
    const products = await odooSource.listAll(opts)

    const { withSku, withoutSku } = partition(products)

    let run = null
    if (runRepo && !dryRun) {
      try {
        run = await runRepo.start({ total, includeNoSku, dryRun })
      } catch (err) {
        log('error', 'product-sync.runRepo.start failed', { error: err.message })
      }
    }

    let batchFailed = false
    let batchResults = []
    try {
      batchResults = await runBatchForOdooItems(withSku, { dryRun })
      if (withSku.length > 0 && batchResults.length === withSku.length && batchResults.every((r) => r.failed)) {
        batchFailed = true
      }
    } catch (err) {
      batchFailed = true
      batchResults = withSku.map((p) => ({ sourceId: p.id, sku: p.default_code, failed: true, error: err.message }))
    }

    const singleResults = await syncSingleItems(withoutSku, { dryRun })

    const results = [...batchResults, ...singleResults]

    const succeeded = results.filter((r) => !r.failed && !r.dryRun && !r.skipped)
    const created = results.filter((r) => r.created === true).length
    const updated = results.filter((r) => r.created === false && !r.failed && !r.dryRun && !r.skipped).length
    const failed = results.filter((r) => r.failed).length
    const skipped = results.filter((r) => r.skipped).length

    if (!dryRun && !batchFailed) await persistMappings(results)

    log('info', 'product-sync.done', {
      total, count: results.length, succeeded: succeeded.length, created, updated, failed, skipped, dryRun
    })

    if (runRepo && run && !dryRun) {
      try {
        await runRepo.complete({
          runId: run._id || run.id,
          created,
          updated,
          skipped,
          failed,
          uniqueSkus: withSku.length - results.filter((r) => r.skipped && r.reason === 'duplicate_sku_in_odoo').length,
          duplicatesInInput: results.filter((r) => r.skipped && r.reason === 'duplicate_sku_in_odoo').length,
          status: batchFailed ? 'failed' : 'completed'
        })
      } catch (err) {
        log('error', 'product-sync.runRepo.complete failed', { error: err.message })
      }
    }

    return results
  }

  async function runIncremental({ includeNoSku = false, overlapMs = DEFAULT_OVERLAP_MS, cursorKey = DEFAULT_CURSOR_KEY } = {}) {
    if (!cursorRepo) throw new Error('createProductSyncModule requires cursorRepo for runIncremental')
    const watermark = (await cursorRepo.get(cursorKey)) || EPOCH_WATERMARK
    log('info', 'product-sync.incremental.start', { cursorKey, watermark, includeNoSku })

    let run = null
    if (runRepo) {
      try {
        run = await runRepo.start({ total: 0, includeNoSku, dryRun: false })
      } catch (err) {
        log('error', 'product-sync.runRepo.start failed', { error: err.message })
      }
    }

    const results = []
    let archived = 0
    let maxSeenMs = parseOdooDateUtc(watermark)
    let batchFailed = false

    for await (const page of odooSource.listChangedSince({ writeDateGte: watermark, includeNoSku })) {
      const activeProducts = []
      for (const product of page) {
        if (product && product.active === false) {
          archived += 1
          continue
        }
        activeProducts.push(product)
        const ms = parseOdooDateUtc(product && product.write_date)
        if (ms != null && (maxSeenMs == null || ms > maxSeenMs)) maxSeenMs = ms
      }

      const { withSku, withoutSku } = partition(activeProducts)

      let pageBatchResults = []
      try {
        pageBatchResults = await runBatchForOdooItems(withSku, { dryRun: false })
      } catch (err) {
        batchFailed = true
        pageBatchResults = withSku.map((p) => ({ sourceId: p.id, sku: p.default_code, failed: true, error: err.message }))
      }
      const pageSingleResults = await syncSingleItems(withoutSku, { dryRun: false })
      results.push(...pageBatchResults, ...pageSingleResults)
    }

    const created = results.filter((r) => r.created === true).length
    const updated = results.filter((r) => r.created === false && !r.failed && !r.skipped).length
    const failed = results.filter((r) => r.failed).length
    const skipped = results.filter((r) => r.skipped).length

    if (!batchFailed) await persistMappings(results)

    let cursorAdvanced = false
    if (failed === 0 && !batchFailed && maxSeenMs != null) {
      await cursorRepo.set(cursorKey, formatOdooDateUtc(maxSeenMs - overlapMs))
      cursorAdvanced = true
    }

    log('info', 'product-sync.incremental.done', {
      cursorKey, count: results.length, created, updated, failed, skipped, archived, cursorAdvanced
    })

    if (runRepo && run) {
      try {
        await runRepo.complete({
          runId: run._id || run.id,
          created,
          updated,
          skipped,
          failed,
          status: (failed > 0 || batchFailed) ? 'failed' : 'completed'
        })
      } catch (err) {
        log('error', 'product-sync.runRepo.complete failed', { error: err.message })
      }
    }

    return { results, created, updated, failed, skipped, archived, cursorAdvanced }
  }

  return { runOnce, runIncremental, syncOneItem }
}

module.exports = { createProductSyncModule }
