'use strict'

const { JOB_KIND } = require('../config/constants')
const { createTickJobModule } = require('../core/application/createTickJobModule')

const SEED_SOURCE_ID = 'product-orphan-reconcile-loop'
const DEFAULT_LIMIT = 200

// (sdd/hubspot-product-reverse-discovery, design D9) Mirrors productSyncJobModule.js's shape
// exactly: a thin createTickJobModule wrapper around the already-composed
// productOrphanReconcileModule (Track A/B flags and repos are baked in at composition time —
// see src/server.js). `limit` bounds each tick's HubSpot search volume to stay inside the
// shared rps:15/burst:20 budget the other scheduled jobs share.
function createProductOrphanReconcileJobModule({
  config = {},
  logger = null,
  jobRepository,
  productOrphanReconcileModule,
  jobPoller = null,
  limit = DEFAULT_LIMIT,
  tickIntervalMs,
  orphanWatchdogMs,
  clock = () => Date.now()
} = {}) {
  if (!jobRepository) throw new Error('createProductOrphanReconcileJobModule requires jobRepository')
  if (!productOrphanReconcileModule) throw new Error('createProductOrphanReconcileJobModule requires productOrphanReconcileModule')

  const tick = createTickJobModule({
    kind: JOB_KIND.PRODUCT_ORPHAN_RECONCILE,
    seedSourceId: SEED_SOURCE_ID,
    logPrefix: 'product-orphan-reconcile-job',
    run: () => productOrphanReconcileModule.run({ limit }),
    buildTickLogDetail: (result) => ({
      scanned: result.scanned,
      promoted: (result.promoted || []).length,
      archived: (result.archived || []).length,
      quarantined: (result.quarantined || []).length
    }),
    config,
    logger,
    jobRepository,
    jobPoller,
    tickIntervalMs,
    orphanWatchdogMs,
    clock
  })

  return {
    processProductOrphanReconcileJob: tick.processTickJob,
    ensureSeeded: tick.ensureSeeded,
    startWorker: tick.startWorker,
    stopWorker: tick.stopWorker,
    _internals: tick._internals
  }
}

module.exports = { createProductOrphanReconcileJobModule }
