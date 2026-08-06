'use strict'

const DEFAULT_LIMIT = 50

function createManufacturingOrderRetrySyncModule({
  mappingRepository,
  odooApiClient,
  hubspotGateway,
  logger = null
} = {}) {
  if (!mappingRepository) throw new Error('createManufacturingOrderRetrySyncModule requires mappingRepository')
  if (!odooApiClient) throw new Error('createManufacturingOrderRetrySyncModule requires odooApiClient')
  if (!hubspotGateway) throw new Error('createManufacturingOrderRetrySyncModule requires hubspotGateway')

  const log = (level, msg, extra) => { if (logger && typeof logger[level] === 'function') logger[level](msg, extra) }

  async function runOnce({ limit = DEFAULT_LIMIT } = {}) {
    const pending = await mappingRepository.findPendingManufacturingOrder({ limit })

    let found = 0
    let stillPending = 0
    let failed = 0

    for (const mapping of pending) {
      try {
        const mo = await odooApiClient.findManufacturingOrderBySaleOrderName(mapping.targetRef)
        if (!mo) {
          stillPending += 1
          continue
        }
        await hubspotGateway.writeBack(mapping.sourceId, { numero_orden_fabricacion: mo.name })
        await mappingRepository.upsert({
          sourceId: mapping.sourceId,
          targetId: mapping.targetId,
          targetRef: mapping.targetRef,
          payloadHash: mapping.payloadHash,
          metadata: { manufacturingOrder: mo }
        })
        found += 1
      } catch (err) {
        failed += 1
        log('error', 'manufacturing-order-retry-sync.item.failed', { sourceId: mapping.sourceId, error: err.message })
      }
    }

    log('info', 'manufacturing-order-retry-sync.done', { found, stillPending, failed, total: pending.length })
    return { found, stillPending, failed }
  }

  return { runOnce }
}

module.exports = { createManufacturingOrderRetrySyncModule }
