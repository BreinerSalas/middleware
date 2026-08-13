'use strict'

const { JOB_KIND } = require('../config/constants')
const { createTickJobModule } = require('../core/application/createTickJobModule')

const SEED_SOURCE_ID = 'sale-order-status-sync-loop'

function createSaleOrderStatusSyncJobModule({
  config = {},
  logger = null,
  jobRepository,
  saleOrderStatusSyncModule,
  jobPoller = null,
  tickIntervalMs,
  orphanWatchdogMs,
  clock = () => Date.now()
} = {}) {
  if (!jobRepository) throw new Error('createSaleOrderStatusSyncJobModule requires jobRepository')
  if (!saleOrderStatusSyncModule) throw new Error('createSaleOrderStatusSyncJobModule requires saleOrderStatusSyncModule')

  const tick = createTickJobModule({
    kind: JOB_KIND.SALE_ORDER_STATUS_SYNC,
    seedSourceId: SEED_SOURCE_ID,
    logPrefix: 'sale-order-status-sync-job',
    run: () => saleOrderStatusSyncModule.runIncremental({}),
    buildTickLogDetail: (result) => ({
      updated: result.updated,
      unmapped: result.unmapped,
      failed: result.failed,
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
    processSaleOrderStatusSyncJob: tick.processTickJob,
    ensureSeeded: tick.ensureSeeded,
    startWorker: tick.startWorker,
    stopWorker: tick.stopWorker,
    _internals: tick._internals
  }
}

module.exports = { createSaleOrderStatusSyncJobModule }