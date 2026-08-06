'use strict'

const { JOB_KIND } = require('../config/constants')
const { JOB_STATUS } = require('../core/domain/SyncJob')
const { JobPoller } = require('../core/application/JobPoller')
const { calculateNextRetry, shouldDeadLetter } = require('../core/domain/RetryPolicy')

const DEFAULT_TICK_INTERVAL_MS = 60 * 1000
const DEFAULT_ORPHAN_WATCHDOG_MS = 30 * 60 * 1000
const SEED_SOURCE_ID = 'sale-order-status-sync-loop'

function createSaleOrderStatusSyncJobModule({
  config = {},
  logger = null,
  jobRepository,
  saleOrderStatusSyncModule,
  jobPoller = null,
  tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
  orphanWatchdogMs = DEFAULT_ORPHAN_WATCHDOG_MS,
  clock = () => Date.now()
} = {}) {
  if (!jobRepository) throw new Error('createSaleOrderStatusSyncJobModule requires jobRepository')
  if (!saleOrderStatusSyncModule) throw new Error('createSaleOrderStatusSyncJobModule requires saleOrderStatusSyncModule')

  const log = (level, msg, extra) => { if (logger && typeof logger[level] === 'function') logger[level](msg, extra) }

  async function scheduleNextTick(now) {
    try {
      await jobRepository.create({
        sourceId: SEED_SOURCE_ID,
        kind: JOB_KIND.SALE_ORDER_STATUS_SYNC,
        status: JOB_STATUS.RETRY_PENDING,
        nextRetryAt: new Date(now + tickIntervalMs),
        attempts: 0,
        maxAttempts: Number.MAX_SAFE_INTEGER
      })
    } catch (err) {
      log('error', 'sale-order-status-sync-job.schedule_next_tick_failed', { error: err.message })
    }
  }

  async function processSaleOrderStatusSyncJob(job) {
    const now = clock()
    try {
      const result = await saleOrderStatusSyncModule.runIncremental({})
      await jobRepository.markCompleted(job._id, new Date(now))
      log('info', 'sale-order-status-sync-job.tick.completed', {
        updated: result.updated,
        unmapped: result.unmapped,
        failed: result.failed,
        cursorAdvanced: result.cursorAdvanced
      })
    } catch (err) {
      const priorAttempts = job.attempts || 0
      const deadLetter = shouldDeadLetter({ attempts: priorAttempts, maxAttempts: job.maxAttempts, error: err })
      const nextRetryAt = deadLetter
        ? null
        : calculateNextRetry({ attempts: priorAttempts, baseMs: 5000, maxDelayMs: (config.retry && config.retry.maxDelayMs) || 300000, now })
      await jobRepository.markFailed(job._id, { error: err, nextRetryAt, deadLetter, now: new Date(now) })
      log('error', 'sale-order-status-sync-job.tick.failed', { error: err.message, deadLetter })
    } finally {
      await scheduleNextTick(now)
    }
  }

  async function ensureSeeded() {
    const active = await jobRepository.existsActive({ kind: JOB_KIND.SALE_ORDER_STATUS_SYNC })
    if (active) return false
    await scheduleNextTick(clock())
    return true
  }

  const _jobPoller = jobPoller || new JobPoller({
    jobRepository,
    processFn: processSaleOrderStatusSyncJob,
    concurrency: 1,
    pollIntervalMs: (config.worker && config.worker.pollIntervalMs) || 5000,
    recoverOrphansOnStart: true,
    kind: JOB_KIND.SALE_ORDER_STATUS_SYNC,
    orphanWatchdogMs,
    logger,
    clock
  })

  return {
    processSaleOrderStatusSyncJob,
    ensureSeeded,
    startWorker: async () => { await ensureSeeded(); return _jobPoller.start() },
    stopWorker: () => _jobPoller.stop(),
    _internals: { jobPoller: _jobPoller }
  }
}

module.exports = { createSaleOrderStatusSyncJobModule }
