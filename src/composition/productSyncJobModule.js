'use strict'

const { JOB_KIND } = require('../config/constants')
const { createTickJobModule } = require('../core/application/createTickJobModule')

const SEED_SOURCE_ID = 'product-sync-loop'

function createProductSyncJobModule({
  config = {},
  logger = null,
  jobRepository,
  productSyncModule,
  jobPoller = null,
  includeNoSku = false,
  tickIntervalMs,
  orphanWatchdogMs,
  clock = () => Date.now()
} = {}) {
  if (!jobRepository) throw new Error('createProductSyncJobModule requires jobRepository')
  if (!productSyncModule) throw new Error('createProductSyncJobModule requires productSyncModule')

  const tick = createTickJobModule({
    kind: JOB_KIND.PRODUCT_SYNC,
    seedSourceId: SEED_SOURCE_ID,
    logPrefix: 'product-sync-job',
    run: () => productSyncModule.runIncremental({ includeNoSku }),
    buildTickLogDetail: (result) => ({
      created: result.created,
      updated: result.updated,
      failed: result.failed,
      skipped: result.skipped,
      archived: result.archived,
      cursorAdvanced: result.cursorAdvanced
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
    processProductSyncJob: tick.processTickJob,
    ensureSeeded: tick.ensureSeeded,
    startWorker: tick.startWorker,
    stopWorker: tick.stopWorker,
    _internals: tick._internals
  }
}

module.exports = { createProductSyncJobModule }