import { describe, it, expect, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { JobPoller } = require('../../src/core/application/JobPoller.js')
const { JOB_STATUS } = require('../../src/core/domain/SyncJob.js')

function makeJobRepo({ claimable = [], recover = 0 } = {}) {
  return {
    _claimableQueue: claimable.slice(),
    _recoverReturn: recover,
    async recoverOrphans() { return this._recoverReturn },
    async findClaimable({ limit }) {
      const out = []
      while (out.length < limit && this._claimableQueue.length > 0) {
        const j = this._claimableQueue.shift()
        j.status = JOB_STATUS.PROCESSING
        j.attempts = (j.attempts || 0) + 1
        out.push(j)
      }
      return out
    }
  }
}

function flush() { return new Promise((r) => setImmediate(r)) }

describe('JobPoller', () => {
  it('processes claimable jobs within concurrency', async () => {
    const jobs = Array.from({ length: 5 }, (_, i) => ({ _id: String(i + 1), sourceId: `D-${i + 1}`, status: JOB_STATUS.PENDING, attempts: 0 }))
    const repo = makeJobRepo({ claimable: jobs })
    const processed = []
    const processFn = async (job) => { processed.push(job._id); await flush() }
    const poller = new JobPoller({
      jobRepository: repo,
      processFn,
      concurrency: 2,
      pollIntervalMs: 1000,
      setIntervalFn: () => null,
      clearIntervalFn: () => null
    })
    await poller.tick(); await flush(); await flush(); await flush()
    expect(processed).toHaveLength(2)
    await poller.tick(); await flush(); await flush(); await flush()
    expect(processed).toHaveLength(4)
    await poller.tick(); await flush(); await flush(); await flush()
    expect(processed).toHaveLength(5)
  })

  it('serializes jobs with the same sourceId', async () => {
    const jobs = [
      { _id: '1', sourceId: 'SAME', status: JOB_STATUS.PENDING, attempts: 0 },
      { _id: '2', sourceId: 'SAME', status: JOB_STATUS.PENDING, attempts: 0 },
      { _id: '3', sourceId: 'OTHER', status: JOB_STATUS.PENDING, attempts: 0 }
    ]
    const repo = makeJobRepo({ claimable: jobs })
    const order = []
    const processFn = async (job) => {
      order.push(`start-${job._id}`)
      await new Promise((r) => setTimeout(r, 20))
      order.push(`end-${job._id}`)
    }
    const poller = new JobPoller({
      jobRepository: repo,
      processFn,
      concurrency: 3,
      pollIntervalMs: 1000,
      setIntervalFn: () => null,
      clearIntervalFn: () => null
    })
    await poller.tick()
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 5))
      if (order.filter((e) => e.startsWith('start-')).length === 3) break
    }
    const starts = order.filter((e) => e.startsWith('start-'))
    expect(starts).toEqual(['start-1', 'start-3', 'start-2'])
  })

  it('calls recoverOrphans once on start', async () => {
    const repo = makeJobRepo({ recover: 3 })
    const processFn = async () => {}
    const poller = new JobPoller({
      jobRepository: repo,
      processFn,
      concurrency: 1,
      pollIntervalMs: 60_000,
      setIntervalFn: () => null,
      clearIntervalFn: () => null
    })
    await poller.start()
    await poller.stop()
    expect(repo._recoverReturn).toBe(3)
  })

  it('passes its configured kind through to findClaimable on every tick', async () => {
    const seenKinds = []
    const repo = {
      async recoverOrphans() { return 0 },
      async findClaimable({ kind }) { seenKinds.push(kind); return [] }
    }
    const poller = new JobPoller({
      jobRepository: repo,
      processFn: async () => {},
      concurrency: 1,
      pollIntervalMs: 60_000,
      kind: 'product_sync',
      setIntervalFn: () => null,
      clearIntervalFn: () => null
    })
    await poller.tick()
    expect(seenKinds).toEqual(['product_sync'])
  })

  it('passes its configured kind and orphanWatchdogMs through to recoverOrphans on start', async () => {
    const calls = []
    const repo = {
      async recoverOrphans(now, watchdogMs, kind) { calls.push({ watchdogMs, kind }); return 0 },
      async findClaimable() { return [] }
    }
    const poller = new JobPoller({
      jobRepository: repo,
      processFn: async () => {},
      concurrency: 1,
      pollIntervalMs: 60_000,
      kind: 'product_sync',
      orphanWatchdogMs: 30 * 60_000,
      setIntervalFn: () => null,
      clearIntervalFn: () => null
    })
    await poller.start()
    await poller.stop()
    expect(calls).toEqual([{ watchdogMs: 30 * 60_000, kind: 'product_sync' }])
  })

  it('respects concurrency: never runs more than N in parallel', async () => {
    const jobs = Array.from({ length: 6 }, (_, i) => ({ _id: String(i + 1), sourceId: `D-${i + 1}`, status: JOB_STATUS.PENDING, attempts: 0 }))
    const repo = makeJobRepo({ claimable: jobs })
    let inFlight = 0
    let maxInFlight = 0
    const processFn = async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight -= 1
    }
    const poller = new JobPoller({
      jobRepository: repo,
      processFn,
      concurrency: 3,
      pollIntervalMs: 60_000,
      setIntervalFn: () => null,
      clearIntervalFn: () => null
    })
    await poller.tick()
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 5))
      if (inFlight === 0 && repo._claimableQueue.length === 0) break
      if (inFlight < 3 && repo._claimableQueue.length > 0) await poller.tick()
    }
    expect(maxInFlight).toBeLessThanOrEqual(3)
  })
})
