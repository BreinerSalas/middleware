'use strict'

const { JOB_STATUS } = require('../domain/SyncJob')
const { JobPoller } = require('./JobPoller')
const { calculateNextRetry, shouldDeadLetter } = require('../domain/RetryPolicy')

const DEFAULT_TICK_INTERVAL_MS = 60 * 1000
const DEFAULT_ORPHAN_WATCHDOG_MS = 30 * 60 * 1000

function createTickJobModule({
  kind,
  seedSourceId,
  run,
  config = {},
  logger = null,
  jobRepository,
  jobPoller = null,
  logPrefix,
  buildTickLogDetail = (result) => result,
  tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
  orphanWatchdogMs = DEFAULT_ORPHAN_WATCHDOG_MS,
  clock = () => Date.now()
} = {}) {
  if (!kind) throw new Error('createTickJobModule requires kind')
  if (!seedSourceId) throw new Error('createTickJobModule requires seedSourceId')
  if (typeof run !== 'function') throw new Error('createTickJobModule requires run')
  if (!jobRepository) throw new Error('createTickJobModule requires jobRepository')
  if (!logPrefix) throw new Error('createTickJobModule requires logPrefix')

  const log = (level, msg, extra) => { if (logger && typeof logger[level] === 'function') logger[level](msg, extra) }

  async function scheduleNextTick(now) {
    try {
      await jobRepository.create({
        sourceId: seedSourceId,
        kind,
        status: JOB_STATUS.RETRY_PENDING,
        nextRetryAt: new Date(now + tickIntervalMs),
        attempts: 0,
        maxAttempts: Number.MAX_SAFE_INTEGER
      })
    } catch (err) {
      log('error', `${logPrefix}.schedule_next_tick_failed`, { error: err.message })
    }
  }

  async function processTickJob(job) {
    const now = clock()
    try {
      const result = await run()
      await jobRepository.markCompleted(job._id, new Date(now))
      log('info', `${logPrefix}.tick.completed`, buildTickLogDetail(result))
    } catch (err) {
      const priorAttempts = job.attempts || 0
      const deadLetter = shouldDeadLetter({ attempts: priorAttempts, maxAttempts: job.maxAttempts, error: err })
      const nextRetryAt = deadLetter
        ? null
        : calculateNextRetry({ attempts: priorAttempts, baseMs: 5000, maxDelayMs: (config.retry && config.retry.maxDelayMs) || 300000, now })
      await jobRepository.markFailed(job._id, { error: err, nextRetryAt, deadLetter, now: new Date(now) })
      log('error', `${logPrefix}.tick.failed`, { error: err.message, deadLetter })
    } finally {
      await scheduleNextTick(now)
    }
  }

  async function ensureSeeded() {
    const active = await jobRepository.existsActive({ kind })
    if (active) return false
    await scheduleNextTick(clock())
    return true
  }

  const _jobPoller = jobPoller || new JobPoller({
    jobRepository,
    processFn: processTickJob,
    concurrency: 1,
    pollIntervalMs: (config.worker && config.worker.pollIntervalMs) || 5000,
    recoverOrphansOnStart: true,
    kind,
    orphanWatchdogMs,
    logger,
    clock
  })

  return {
    processTickJob,
    ensureSeeded,
    startWorker: async () => { await ensureSeeded(); return _jobPoller.start() },
    stopWorker: () => _jobPoller.stop(),
    _internals: { jobPoller: _jobPoller }
  }
}

module.exports = { createTickJobModule }