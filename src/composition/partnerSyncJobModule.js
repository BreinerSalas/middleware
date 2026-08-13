'use strict'

const { JOB_KIND } = require('../config/constants')
const { createTickJobModule } = require('../core/application/createTickJobModule')

const DEFAULT_TICK_INTERVAL_MS = 60 * 1000
const DEFAULT_ORPHAN_WATCHDOG_MS = 30 * 60 * 1000
const SEED_SOURCE_ID = 'partner-sync-loop'

function createPartnerSyncJobModule({
  config = {},
  logger = null,
  jobRepository,
  partnerSyncModule,
  jobPoller = null,
  tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
  orphanWatchdogMs = DEFAULT_ORPHAN_WATCHDOG_MS,
  clock = () => Date.now()
} = {}) {
  if (!jobRepository) throw new Error('createPartnerSyncJobModule requires jobRepository')
  if (!partnerSyncModule) throw new Error('createPartnerSyncJobModule requires partnerSyncModule')

  const tick = createTickJobModule({
    kind: JOB_KIND.PARTNER_SYNC,
    seedSourceId: SEED_SOURCE_ID,
    logPrefix: 'partner-sync-job',
    run: () => partnerSyncModule.runIncremental(),
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
    processPartnerSyncJob: tick.processTickJob,
    ensureSeeded: tick.ensureSeeded,
    startWorker: tick.startWorker,
    stopWorker: tick.stopWorker,
    _internals: tick._internals
  }
}

module.exports = { createPartnerSyncJobModule }