'use strict'

const { parseOdooDateUtc, formatOdooDateUtc } = require('../core/shared/odooDate')

const DEFAULT_OVERLAP_MS = 60 * 1000
const EPOCH_WATERMARK = '1970-01-01 00:00:00'
const DEFAULT_CURSOR_KEY = 'partner-sync'

function createPartnerSyncModule({
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
  if (!odooSource) throw new Error('createPartnerSyncModule requires odooSource')
  if (!hubspotGateway) throw new Error('createPartnerSyncModule requires hubspotGateway')

  const log = (level, msg, extra) => { if (logger && typeof logger[level] === 'function') logger[level](msg, extra) }

  const idProperty = hubspotGateway.idProperty || 'id_contacto_odoo'

  function dryRunItem(odooPartner) {
    return { id: odooPartner.id, dryRun: true, created: false, skipped: true }
  }

  async function syncOneItem(odooPartner, { dryRun } = {}) {
    if (dryRun) return dryRunItem(odooPartner)
    return hubspotGateway.upsertByOdooId(odooPartner)
  }

  async function runBatchForOdooItems(odooPartners, { dryRun }) {
    const results = []
    log('info', 'partner-sync.batch.started', { chunkSize, items: odooPartners.length, dryRun })
    if (dryRun) {
      for (const p of odooPartners) results.push({ sourceId: p.id, ...dryRunItem(p) })
      return results
    }
    if (odooPartners.length === 0) return results

    let batchSummary
    try {
      batchSummary = await hubspotGateway.batchUpsertByOdooIds(odooPartners, { chunkSize })
    } catch (err) {
      for (const p of odooPartners) results.push({ sourceId: p.id, failed: true, error: err.message })
      log('error', 'partner-sync.chunk.failed', { items: odooPartners.length, error: err.message })
      return results
    }

    const odooIdToPartner = new Map()
    for (const p of odooPartners) odooIdToPartner.set(String(p.id), p)
    const seenIds = new Set()

    for (const item of batchSummary.results || []) {
      const idValue = item.properties && item.properties[idProperty]
      const partner = idValue != null ? odooIdToPartner.get(String(idValue)) : null
      if (!partner) continue
      seenIds.add(String(partner.id))
      const isNew = item.new === true || (item.createdAt && item.createdAt === item.updatedAt)
      results.push({
        sourceId: partner.id,
        id: item.id,
        created: Boolean(isNew),
        action: isNew ? 'created' : 'updated',
        hubspotId: item.id
      })
    }

    for (const errItem of batchSummary.errors || []) {
      log('error', 'partner-sync.item.failed', { odooId: errItem.id, error: errItem.message, category: errItem.category })
      const partner = odooIdToPartner.get(String(errItem.id))
      if (partner) {
        seenIds.add(String(partner.id))
        results.push({ sourceId: partner.id, failed: true, error: errItem.message })
      }
    }

    for (const entry of batchSummary.skipped || []) {
      if (entry == null) continue
      const sourceId = typeof entry === 'object' ? entry.sourceId : entry
      const reason = typeof entry === 'object' ? entry.reason : 'no_id'
      if (sourceId == null) continue
      seenIds.add(String(sourceId))
      results.push({ sourceId, skipped: true, reason })
    }

    for (const p of odooPartners) {
      const key = String(p.id)
      if (seenIds.has(key)) continue
      results.push({ sourceId: p.id, assumed: 'updated' })
    }

    log('info', 'partner-sync.batch.summary', {
      chunks: Math.ceil(odooPartners.length / chunkSize),
      items: odooPartners.length,
      results: (batchSummary.results || []).length,
      errors: (batchSummary.errors || []).length
    })
    return results
  }

  async function persistMappings(results) {
    if (!mappingRepo) return
    const toPersist = results
      .filter((r) => r.hubspotId && r.sourceId != null && !r.failed && !r.dryRun && !r.skipped)
      .map((r) => ({
        odooId: r.sourceId,
        hubspotId: r.hubspotId,
        action: r.action || (r.created ? 'created' : 'updated')
      }))
    if (toPersist.length === 0) return
    try {
      await mappingRepo.bulkUpsertMany({ items: toPersist })
    } catch (err) {
      log('error', 'partner-sync.mappingRepo.bulkUpsertMany failed', { error: err.message, count: toPersist.length })
    }
  }

  async function runOnce({ limit = null, dryRun = false } = {}) {
    const total = await odooSource.count()
    log('info', 'partner-sync.start', { total, limit, dryRun })
    const opts = {}
    if (limit != null) opts.limit = limit
    const partners = await odooSource.listAll(opts)

    let run = null
    if (runRepo && !dryRun) {
      try {
        run = await runRepo.start({ total, dryRun })
      } catch (err) {
        log('error', 'partner-sync.runRepo.start failed', { error: err.message })
      }
    }

    let batchFailed = false
    let results = []
    if (dryRun) {
      for (const p of partners) results.push({ sourceId: p.id, ...(await syncOneItem(p, { dryRun: true })) })
    } else {
      try {
        results = await runBatchForOdooItems(partners, { dryRun: false })
        if (partners.length > 0 && results.length === partners.length && results.every((r) => r.failed)) {
          batchFailed = true
        }
      } catch (err) {
        batchFailed = true
        results = partners.map((p) => ({ sourceId: p.id, failed: true, error: err.message }))
      }
    }

    const succeeded = results.filter((r) => !r.failed && !r.dryRun && !r.skipped)
    const created = results.filter((r) => r.created === true).length
    const updated = results.filter((r) => r.created === false && !r.failed && !r.dryRun && !r.skipped).length
    const failed = results.filter((r) => r.failed).length
    const skipped = results.filter((r) => r.skipped).length

    if (!dryRun && !batchFailed) await persistMappings(results)

    log('info', 'partner-sync.done', {
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
        log('error', 'partner-sync.runRepo.complete failed', { error: err.message })
      }
    }

    return results
  }

  async function runIncremental({ overlapMs = DEFAULT_OVERLAP_MS, cursorKey = DEFAULT_CURSOR_KEY } = {}) {
    if (!cursorRepo) throw new Error('createPartnerSyncModule requires cursorRepo for runIncremental')
    const watermark = (await cursorRepo.get(cursorKey)) || EPOCH_WATERMARK
    log('info', 'partner-sync.incremental.start', { cursorKey, watermark })

    let run = null
    if (runRepo) {
      try {
        run = await runRepo.start({ total: 0, dryRun: false })
      } catch (err) {
        log('error', 'partner-sync.runRepo.start failed', { error: err.message })
      }
    }

    const results = []
    let archived = 0
    let maxSeenMs = parseOdooDateUtc(watermark)
    let batchFailed = false

    for await (const page of odooSource.listChangedSince({ writeDateGte: watermark })) {
      const activePartners = []
      for (const partner of page) {
        if (partner && partner.active === false) {
          archived += 1
          continue
        }
        activePartners.push(partner)
        const ms = parseOdooDateUtc(partner && partner.write_date)
        if (ms != null && (maxSeenMs == null || ms > maxSeenMs)) maxSeenMs = ms
      }

      let pageResults = []
      try {
        pageResults = await runBatchForOdooItems(activePartners, { dryRun: false })
      } catch (err) {
        batchFailed = true
        pageResults = activePartners.map((p) => ({ sourceId: p.id, failed: true, error: err.message }))
      }
      results.push(...pageResults)
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

    log('info', 'partner-sync.incremental.done', {
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
          archived,
          status: (failed > 0 || batchFailed) ? 'failed' : 'completed'
        })
      } catch (err) {
        log('error', 'partner-sync.runRepo.complete failed', { error: err.message })
      }
    }

    return { results, created, updated, failed, skipped, archived, cursorAdvanced }
  }

  return { runOnce, runIncremental, syncOneItem }
}

module.exports = { createPartnerSyncModule }
