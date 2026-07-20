'use strict'

const { runSequentially } = require('../shared/mutex')

class JobPoller {
  constructor({
    jobRepository,
    processFn,
    concurrency = 3,
    pollIntervalMs = 5000,
    mutex = runSequentially,
    recoverOrphansOnStart = true,
    logger = null,
    clock = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
  } = {}) {
    if (!jobRepository) throw new Error('JobPoller requires jobRepository')
    if (typeof processFn !== 'function') throw new Error('JobPoller requires processFn')
    this.jobRepository = jobRepository
    this.processFn = processFn
    this.concurrency = Math.max(1, Number(concurrency) || 1)
    this.pollIntervalMs = Math.max(100, Number(pollIntervalMs) || 5000)
    this.mutex = mutex
    this.recoverOrphansOnStart = recoverOrphansOnStart
    this.logger = logger
    this.clock = clock
    this.setIntervalFn = setIntervalFn
    this.clearIntervalFn = clearIntervalFn
    this._timer = null
    this._running = false
    this._inflight = 0
  }

  async start() {
    if (this._running) return
    this._running = true
    if (this.recoverOrphansOnStart) {
      try {
        const recovered = await this.jobRepository.recoverOrphans(new Date(this.clock()))
        if (this.logger) this.logger.info('poller.recoverOrphans', { recovered })
      } catch (err) {
        if (this.logger) this.logger.warn('poller.recoverOrphans failed', { error: err.message })
      }
    }
    this._timer = this.setIntervalFn(() => {
      if (!this._running) return
      this._tick().catch((err) => {
        if (this.logger) this.logger.warn('poller.tick error', { error: err.message })
      })
    }, this.pollIntervalMs)
    await this._tick()
  }

  async stop() {
    this._running = false
    if (this._timer) {
      this.clearIntervalFn(this._timer)
      this._timer = null
    }
    while (this._inflight > 0) {
      await new Promise((r) => setImmediate(r))
    }
  }

  async _tick() {
    const free = Math.max(0, this.concurrency - this._inflight)
    if (free === 0) return
    let claimed = []
    try {
      claimed = await this.jobRepository.findClaimable({ limit: free, now: new Date(this.clock()) })
    } catch (err) {
      if (this.logger) this.logger.warn('poller.findClaimable failed', { error: err.message })
      return
    }
    if (!claimed || claimed.length === 0) return
    for (const job of claimed) {
      this._inflight += 1
      const run = async () => {
        try {
          await this.processFn(job)
        } catch (err) {
          if (this.logger) this.logger.error('poller.processFn unhandled', { error: err.message, stack: err.stack })
        } finally {
          this._inflight -= 1
        }
      }
      this.mutex(job.sourceId, run).catch((err) => {
        if (this.logger) this.logger.error('poller.mutex error', { error: err.message })
        this._inflight -= 1
      })
    }
  }

  // Manually trigger one tick (used by tests)
  async tick() { return this._tick() }
}

module.exports = { JobPoller }
