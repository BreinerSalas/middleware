'use strict'

const { parseOdooDateUtc, formatOdooDateUtc } = require('../adapters/outbound/odoo/odooDate')
const { isPermanentHttpError } = require('../core/domain/RetryPolicy')
const { parseSourceId } = require('../adapters/outbound/hubspot/HubspotSourceGateway')

const DEFAULT_OVERLAP_MS = 60 * 1000
const EPOCH_WATERMARK = '1970-01-01 00:00:00'
const DEFAULT_CURSOR_KEY = 'sale-order-status-sync'

function createSaleOrderStatusSyncModule({
  odooSource,
  mappingRepository,
  hubspotGateway,
  logger = null,
  cursorRepo = null,
  revertQuoteReleaseOnCancellation = null
} = {}) {
  if (!odooSource) throw new Error('createSaleOrderStatusSyncModule requires odooSource')
  if (!mappingRepository) throw new Error('createSaleOrderStatusSyncModule requires mappingRepository')
  if (!hubspotGateway) throw new Error('createSaleOrderStatusSyncModule requires hubspotGateway')

  const log = (level, msg, extra) => { if (logger && typeof logger[level] === 'function') logger[level](msg, extra) }

  async function runIncremental({ overlapMs = DEFAULT_OVERLAP_MS, cursorKey = DEFAULT_CURSOR_KEY } = {}) {
    if (!cursorRepo) throw new Error('createSaleOrderStatusSyncModule requires cursorRepo for runIncremental')
    const watermark = (await cursorRepo.get(cursorKey)) || EPOCH_WATERMARK
    log('info', 'sale-order-status-sync.incremental.start', { cursorKey, watermark })

    let updated = 0
    let unmapped = 0
    let failed = 0
    let permanentlyFailed = 0
    let maxSeenMs = parseOdooDateUtc(watermark)

    for await (const page of odooSource.listChangedSince({ writeDateGte: watermark })) {
      for (const row of page) {
        const ms = parseOdooDateUtc(row && row.write_date)
        if (ms != null && (maxSeenMs == null || ms > maxSeenMs)) maxSeenMs = ms
        try {
          const mapping = await mappingRepository.findByTargetId(String(row.id))
          if (!mapping) {
            unmapped += 1
            continue
          }
          const writeBackPayload = {
            estado_presupuesto_odoo: row.state,
            estado_facturacion_odoo: row.invoice_status
          }
          if (row.state === 'cancel') writeBackPayload.numero_orden_fabricacion = null
          await hubspotGateway.writeBack(mapping.sourceId, writeBackPayload)
          if (row.state === 'cancel') {
            const { quoteId } = parseSourceId(mapping.sourceId)
            if (quoteId) {
              // Quote-kind sourceId (${dealId}:q${quoteId}) — per-quote gating flow. No
              // alreadyReverted echo-guard needed here (unlike the deal-stage branch below):
              // tracker.cancel() is idempotent, so re-running this for the same cancelled
              // sale.order on a later overlap tick is a harmless no-op, not a repeated
              // side effect to guard against.
              if (revertQuoteReleaseOnCancellation) {
                await revertQuoteReleaseOnCancellation.execute({
                  quoteId,
                  reason: `Odoo sale.order ${row.id} cancelled`
                })
              } else {
                log('warn', 'sale-order-status-sync.quote_release_revert.skipped_no_dependency', {
                  quoteId, sourceId: mapping.sourceId
                })
              }
            } else {
              // Legacy deal-kind sourceId — reverting the whole deal's stage is a repeatable
              // side effect on HubSpot, so guard it against being repeated for the same
              // cancellation across overlapping incremental ticks.
              const alreadyReverted = mapping.metadata && mapping.metadata.lastCancelRevertedWriteDate === row.write_date
              if (!alreadyReverted) {
                await hubspotGateway.revertDealStage(mapping.sourceId)
                await mappingRepository.upsert({
                  sourceId: mapping.sourceId,
                  targetId: mapping.targetId,
                  targetRef: mapping.targetRef,
                  payloadHash: mapping.payloadHash,
                  metadata: { lastCancelRevertedWriteDate: row.write_date }
                })
              }
            }
          }
          updated += 1
        } catch (err) {
          if (isPermanentHttpError(err)) {
            permanentlyFailed += 1
            log('warn', 'sale-order-status-sync.item.permanently_failed', { odooId: row && row.id, error: err.message })
          } else {
            failed += 1
            log('error', 'sale-order-status-sync.item.failed', { odooId: row && row.id, error: err.message })
          }
        }
      }
    }

    let cursorAdvanced = false
    if (failed === 0 && maxSeenMs != null) {
      await cursorRepo.set(cursorKey, formatOdooDateUtc(maxSeenMs - overlapMs))
      cursorAdvanced = true
    }

    log('info', 'sale-order-status-sync.incremental.done', { cursorKey, updated, unmapped, failed, permanentlyFailed, cursorAdvanced })

    return { updated, unmapped, failed, permanentlyFailed, cursorAdvanced }
  }

  return { runIncremental }
}

module.exports = { createSaleOrderStatusSyncModule }
