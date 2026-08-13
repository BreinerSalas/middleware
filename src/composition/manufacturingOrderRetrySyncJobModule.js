'use strict'

const { JOB_KIND } = require('../config/constants')
const { createTickJobModule } = require('../core/application/createTickJobModule')

const SEED_SOURCE_ID = 'manufacturing-order-retry-sync-loop'

function createManufacturingOrderRetrySyncJobModule({
  config = {},
  logger = null,
  jobRepository,
  manufacturingOrderRetrySyncModule,
  jobPoller = null,
  tickIntervalMs,
  orphanWatchdogMs,
  clock = () => Date.now()
} = {}) {
  if (!jobRepository) throw new Error('createManufacturingOrderRetrySyncJobModule requires jobRepository')
  if (!manufacturingOrderRetrySyncModule) throw new Error('createManufacturingOrderRetrySyncJobModule requires manufacturingOrderRetrySyncModule')

  const tick = createTickJobModule({
    kind: JOB_KIND.MANUFACTURING_ORDER_RETRY_SYNC,
    seedSourceId: SEED_SOURCE_ID,
    logPrefix: 'manufacturing-order-retry-sync-job',
    run: () => manufacturingOrderRetrySyncModule.runOnce({}),
    config,
    logger,
    jobRepository,
    jobPoller,
    tickIntervalMs,
    orphanWatchdogMs,
    clock
  })

  return {
    processManufacturingOrderRetrySyncJob: tick.processTickJob,
    ensureSeeded: tick.ensureSeeded,
    startWorker: tick.startWorker,
    stopWorker: tick.stopWorker,
    _internals: tick._internals
  }
}

module.exports = { createManufacturingOrderRetrySyncJobModule }