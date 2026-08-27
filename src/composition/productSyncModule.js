'use strict'

const async = require('async')
const { parseOdooDateUtc, formatOdooDateUtc } = require('../adapters/outbound/odoo/odooDate')

const DEFAULT_OVERLAP_MS = 60 * 1000
const EPOCH_WATERMARK = '1970-01-01 00:00:00'
const DEFAULT_CURSOR_KEY = 'product-sync'

// (openspec/hubspot-product-odoo-id-key) Catalog sync identity is now keyed on the Odoo
// product.product.id. There is no SKU partition, no SKU echo correlation, no `no_sku` skip
// paths. `hs_sku` is informational only — it travels in the upsert payload but is never
// matched on.
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
      batchSummary = await hubspotGateway.batchUpsertByOdooIds(odooProducts, { chunkSize })
    } catch (err) {
      for (const p of odooProducts) results.push({ sourceId: p.id, sku: p.default_code, failed: true, error: err.message })
      log('error', 'product-sync.chunk.failed', { items: odooProducts.length, error: err.message })
      return results
    }
    // Correlation by sent Odoo id. HubSpot echoes `id_producto_odoo` back on each result, so
    // we use that as the primary key. If the echo is absent (HubSpot omits the property on
    // an upsert that updated an existing product), fall back to the input order — the
    // gateway preserves order on its end, and any echo-matched result is removed from the
    // index-fallback pool first.
    const idToProduct = new Map()
    for (const p of odooProducts) idToProduct.set(String(p.id), p)
    const odooIds = odooProducts.map((p) => String(p.id))

    const resultByEchoedId = new Map()
    const resultByIndex = [] // ordered list of results NOT claimed by an echo match
    for (let i = 0; i < (batchSummary.results || []).length; i += 1) {
      const item = batchSummary.results[i]
      const echoed = item && item.properties && item.properties.id_producto_odoo
      if (echoed != null) {
        resultByEchoedId.set(String(echoed), item)
      } else {
        resultByIndex.push(item)
      }
    }
    const errorByEchoedId = new Map()
    const errorByIndex = [] // ordered list of errors NOT claimed by an echo match
    for (let i = 0; i < (batchSummary.errors || []).length; i += 1) {
      const errItem = batchSummary.errors[i]
      if (errItem.id != null) {
        errorByEchoedId.set(String(errItem.id), errItem)
      } else {
        errorByIndex.push(errItem)
      }
    }

    const seenSourceIds = new Set()
    let resultIdx = 0
    let errorIdx = 0
    for (const oid of odooIds) {
      const product = idToProduct.get(oid)
      // 1) Try echo match on a success result.
      let item = resultByEchoedId.get(oid)
      // 2) Otherwise consume the next unclaimed result (no echo).
      if (item == null && resultIdx < resultByIndex.length) {
        item = resultByIndex[resultIdx]
        resultIdx += 1
      }
      if (item) {
        const isNew = item.new === true || (item.createdAt && item.createdAt === item.updatedAt)
        results.push({
          sourceId: Number(oid),
          sku: product ? product.default_code : undefined,
          id: item.id,
          created: Boolean(isNew),
          action: isNew ? 'created' : 'updated',
          hubspotId: item.id
        })
        seenSourceIds.add(oid)
        continue
      }
      // 3) Try echo match on an error.
      let errItem = errorByEchoedId.get(oid)
      // 4) Otherwise consume the next unclaimed error.
      if (errItem == null && errorIdx < errorByIndex.length) {
        errItem = errorByIndex[errorIdx]
        errorIdx += 1
      }
      if (errItem) {
        log('error', 'product-sync.item.failed', { odooId: errItem.id, error: errItem.message, category: errItem.category })
        results.push({
          sourceId: Number(oid),
          sku: product ? product.default_code : undefined,
          failed: true,
          error: errItem.message
        })
        seenSourceIds.add(oid)
      }
    }
    // Consume the gateway's richer skipped list ({sourceId, reason}, e.g. duplicate_in_hubspot
    // or invalid_property_value isolated during the per-chunk fallback).
    for (const entry of batchSummary.skipped || []) {
      if (entry == null) continue
      const sourceId = typeof entry === 'object' ? entry.sourceId : entry
      const reason = typeof entry === 'object' ? entry.reason : 'unknown'
      if (sourceId == null) continue
      if (seenSourceIds.has(String(sourceId))) continue
      seenSourceIds.add(String(sourceId))
      const product = idToProduct.get(String(sourceId))
      results.push({ sourceId, sku: product ? product.default_code : undefined, skipped: true, reason })
    }
    // Anything still unseen (no result / no error / no skipped entry) → assume updated.
    for (const oid of odooIds) {
      if (seenSourceIds.has(oid)) continue
      const product = idToProduct.get(oid)
      results.push({
        sourceId: Number(oid),
        sku: product ? product.default_code : undefined,
        assumed: 'updated'
      })
    }
    log('info', 'product-sync.batch.summary', {
      chunks: Math.ceil(odooProducts.length / chunkSize),
      items: odooProducts.length,
      results: (batchSummary.results || []).length,
      errors: (batchSummary.errors || []).length,
      duplicatesSkipped: (batchSummary.skipped || []).length
    })
    return results
  }

  // (2026-08-22 production incident) batchUpsertProducts' idProperty-based matching can
  // intermittently fail to find an Odoo product's existing HubSpot record and create a
  // duplicate instead of updating it — silently, with no batch-level error, and with
  // id_producto_odoo left unset on the new duplicate (confirmed against production data: the
  // same ~9 Odoo products were re-"created" on every 1-minute incremental run for 10+ minutes
  // straight). A `created: true` result for an odooId that already has a mapping pointing at a
  // DIFFERENT hubspotId is proof of exactly this: never let it silently overwrite the correct
  // mapping — that would point the source of truth at throwaway HubSpot clutter and hide the
  // anomaly. Surface it loudly instead; the existing mapping is left untouched.
  async function detectDuplicateCreate(result) {
    if (!result.created || typeof mappingRepo.findByOdooId !== 'function') return false
    let existing = null
    try {
      existing = await mappingRepo.findByOdooId(result.sourceId)
    } catch (err) {
      log('error', 'product-sync.mappingRepo.findByOdooId failed', { odooId: result.sourceId, error: err.message })
      return false
    }
    if (existing && existing.hubspotId && String(existing.hubspotId) !== String(result.hubspotId)) {
      log('error', 'product-sync.duplicate_create_detected', {
        odooId: result.sourceId, existingHubspotId: existing.hubspotId, newHubspotId: result.hubspotId
      })
      return true
    }
    return false
  }

  async function persistMappings(results) {
    if (!mappingRepo) return
    const candidates = results.filter((r) => r.hubspotId && r.sourceId != null && !r.failed && !r.dryRun && !r.skipped)
    const toPersist = []
    for (const r of candidates) {
      if (await detectDuplicateCreate(r)) continue
      const sku = r.sku
      const normalizedHsSku = (sku == null || sku === false || (typeof sku === 'string' && sku.trim() === ''))
        ? null
        : String(sku)
      toPersist.push({
        odooId: r.sourceId,
        hsSku: normalizedHsSku,
        hubspotId: r.hubspotId,
        action: r.action || (r.created ? 'created' : 'updated')
      })
    }
    // (openspec/hubspot-product-odoo-id-key) NO `hsSku`-truthy filter — every product with a
    // hubspotId is persisted, including no-SKU products (hsSku: null).
    if (toPersist.length === 0) return
    try {
      await mappingRepo.bulkUpsertMany({ items: toPersist })
    } catch (err) {
      log('error', 'product-sync.mappingRepo.bulkUpsertMany failed', { error: err.message, count: toPersist.length })
    }
  }

  async function runOnce({ limit = null, dryRun = false, includeNoSku = true } = {}) {
    const total = await odooSource.count({ includeNoSku })
    log('info', 'product-sync.start', { total, limit, dryRun, includeNoSku })
    const opts = { includeNoSku }
    if (limit != null) opts.limit = limit
    const products = await odooSource.listAll(opts)

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
      batchResults = await runBatchForOdooItems(products, { dryRun })
      if (products.length > 0 && batchResults.length === products.length && batchResults.every((r) => r.failed)) {
        batchFailed = true
      }
    } catch (err) {
      batchFailed = true
      batchResults = products.map((p) => ({ sourceId: p.id, sku: p.default_code, failed: true, error: err.message }))
    }

    const results = [...batchResults]

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
          status: batchFailed ? 'failed' : 'completed'
        })
      } catch (err) {
        log('error', 'product-sync.runRepo.complete failed', { error: err.message })
      }
    }

    return results
  }

  async function runIncremental({ includeNoSku = true, overlapMs = DEFAULT_OVERLAP_MS, cursorKey = DEFAULT_CURSOR_KEY } = {}) {
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

      let pageBatchResults = []
      try {
        pageBatchResults = await runBatchForOdooItems(activeProducts, { dryRun: false })
      } catch (err) {
        batchFailed = true
        pageBatchResults = activeProducts.map((p) => ({ sourceId: p.id, sku: p.default_code, failed: true, error: err.message }))
      }
      results.push(...pageBatchResults)
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

  // Kept for backward compatibility — single-item upserts are no longer used by runOnce/runIncremental
  // (the gateway's batchUpsertByOdooIds covers every product), but productSyncJobModule.test.js etc.
  // may still call it for legacy / probe paths.
  async function syncOneItem(odooProduct, { dryRun } = {}) {
    if (dryRun) return dryRunItem(odooProduct)
    return hubspotGateway.upsertByOdooId(odooProduct)
  }

  return { runOnce, runIncremental, syncOneItem }
}

module.exports = { createProductSyncModule }
