import { describe, it, expect, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { EnqueueSyncJobUseCase } = require('../../src/core/application/use-cases/EnqueueSyncJobUseCase.js')
const { ProcessSyncJobUseCase } = require('../../src/core/application/use-cases/ProcessSyncJobUseCase.js')
const { JOB_STATUS } = require('../../src/core/domain/SyncJob.js')
const { SkipSyncError, TransientSyncError } = require('../../src/core/domain/errors.js')

function makeInMemoryJobRepository() {
  const jobs = new Map()
  let counter = 0
  return {
    async create(job) {
      counter += 1
      const id = String(counter)
      const data = job && typeof job.toJSON === 'function' ? job.toJSON() : { ...job }
      const stored = { ...data, _id: id, createdAt: data.createdAt || new Date(), updatedAt: new Date() }
      jobs.set(id, stored)
      return { ...stored }
    },
    async findById(id) { return jobs.get(id) ? { ...jobs.get(id) } : null },
    async findClaimable({ limit = 3, now = new Date() } = {}) {
      const claimable = []
      for (const j of jobs.values()) {
        if (claimable.length >= limit) break
        if (j.status === JOB_STATUS.COMPLETED || j.status === JOB_STATUS.SKIPPED || j.status === JOB_STATUS.DEAD_LETTER) continue
        if (j.status === JOB_STATUS.PENDING || (j.status === JOB_STATUS.RETRY_PENDING && (!j.nextRetryAt || j.nextRetryAt <= now))) {
          j.status = JOB_STATUS.PROCESSING
          j.attempts = (j.attempts || 0) + 1
          j.updatedAt = now
          claimable.push({ ...j })
        }
      }
      return claimable
    },
    async markCompleted(id, now = new Date()) {
      const j = jobs.get(id); if (!j) return null
      j.status = JOB_STATUS.COMPLETED; j.completedAt = now; j.lastError = null; j.nextRetryAt = null
      return { ...j }
    },
    async markSkipped(id, reason, now = new Date()) {
      const j = jobs.get(id); if (!j) return null
      j.status = JOB_STATUS.SKIPPED; j.completedAt = now
      j.lastError = reason instanceof Error ? (reason.reason || reason.message) : String(reason)
      return { ...j }
    },
    async markFailed(id, { error, nextRetryAt = null, deadLetter = false, now = new Date() }) {
      const j = jobs.get(id); if (!j) return null
      j.lastError = error ? (error.message || String(error)) : 'Unknown error'
      j.updatedAt = now
      if (deadLetter) {
        j.status = JOB_STATUS.DEAD_LETTER; j.completedAt = now; j.nextRetryAt = null
      } else {
        j.status = JOB_STATUS.RETRY_PENDING; j.nextRetryAt = nextRetryAt
      }
      return { ...j }
    },
    async recoverOrphans() { return 0 },
    _all: () => Array.from(jobs.values()).map((j) => ({ ...j }))
  }
}

function makeInMemoryMappingRepository() {
  const map = new Map()
  return {
    async findBySourceId(sourceId) { return map.get(sourceId) ? { ...map.get(sourceId) } : null },
    async upsert(m) {
      const prev = map.get(m.sourceId) || { sourceId: m.sourceId, metadata: {}, createdAt: new Date() }
      const next = { ...prev, targetId: m.targetId, targetRef: m.targetRef, payloadHash: m.payloadHash, lastSyncedAt: new Date(), metadata: { ...prev.metadata, ...(m.metadata || {}) }, updatedAt: new Date() }
      map.set(m.sourceId, next)
      return { ...next }
    },
    _all: () => Array.from(map.values()).map((v) => ({ ...v }))
  }
}

function makeInMemoryDedupeGuard() {
  const seen = new Set()
  return {
    async isDuplicate(key) { return seen.has(key) },
    async markSeen(key) { seen.add(key) },
    _reset() { seen.clear() }
  }
}

function makeInMemoryAuditTrail() {
  const entries = []
  return {
    async record(entry) { entries.push({ ...entry, createdAt: entry.createdAt || new Date() }); return { ...entry } },
    _all: () => entries.slice()
  }
}

function fakeSourceGateway(overrides = {}) {
  return {
    async fetchRecord(sourceId) { return { id: sourceId, properties: { id_cliente_odoo: '42', dealstage: 'closedwon' }, ...(overrides.fetchRecord || {}) } },
    async resolveReferences() { return { odooCustomerId: '42', lineItems: [{ id: 'L-1', hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'Item 1' }] } },
    async writeBack() {},
    ...overrides
  }
}

function fakeTargetGateway(overrides = {}) {
  return {
    async upsert({ existingTargetId = null } = {}) {
      if (overrides.upsert) return overrides.upsert({ existingTargetId })
      return { targetId: existingTargetId || 'stub-1', targetRef: 'STUB/1', syncToken: 'draft' }
    }
  }
}

describe('EnqueueSyncJobUseCase', () => {
  let jobRepo, dedupe, audit, uc
  beforeEach(() => {
    jobRepo = makeInMemoryJobRepository()
    dedupe = makeInMemoryDedupeGuard()
    audit = makeInMemoryAuditTrail()
    uc = new EnqueueSyncJobUseCase({ jobRepository: jobRepo, dedupeGuard: dedupe })
  })

  it('creates a pending job when not duplicate', async () => {
    const result = await uc.execute({ sourceId: 'D-1', rawPayload: { x: 1 }, correlationId: 'c-1' })
    expect(result.deduped).toBe(false)
    expect(result.job.status).toBe(JOB_STATUS.PENDING)
    expect(result.job.sourceId).toBe('D-1')
    expect(result.job.attempts).toBe(0)
    expect(result.dedupeKey).toMatch(/^D-1:/)
  })

  it('returns deduped=true and does not persist when duplicate', async () => {
    await uc.execute({ sourceId: 'D-1', rawPayload: { x: 1 } })
    const r2 = await uc.execute({ sourceId: 'D-1', rawPayload: { x: 1 } })
    expect(r2.deduped).toBe(true)
    expect(r2.job).toBeNull()
    expect(jobRepo._all()).toHaveLength(1)
  })

  it('fail-open when isDuplicate throws', async () => {
    const broken = { isDuplicate: async () => { throw new Error('boom') }, markSeen: async () => {} }
    const u = new EnqueueSyncJobUseCase({ jobRepository: jobRepo, dedupeGuard: broken })
    const r = await u.execute({ sourceId: 'D-1', rawPayload: { x: 1 } })
    expect(r.deduped).toBe(false)
    expect(r.job.status).toBe(JOB_STATUS.PENDING)
  })

  it('requires sourceId', async () => {
    await expect(uc.execute({ sourceId: '' })).rejects.toThrow(/sourceId/)
  })
})

describe('ProcessSyncJobUseCase', () => {
  let jobRepo, mappingRepo, audit, sourceGw, targetGw, uc
  beforeEach(() => {
    jobRepo = makeInMemoryJobRepository()
    mappingRepo = makeInMemoryMappingRepository()
    audit = makeInMemoryAuditTrail()
    sourceGw = fakeSourceGateway()
    targetGw = fakeTargetGateway()
    uc = new ProcessSyncJobUseCase({
      jobRepository: jobRepo,
      mappingRepository: mappingRepo,
      sourceGateway: sourceGw,
      targetGateway: targetGw,
      auditTrail: audit,
      validators: [],
      retryPolicy: { maxDelayMs: 60_000, jitter: false, buildWriteBackPayload: (m) => ({ ref: m.targetRef }) }
    })
  })

  it('happy path: completes and writes back', async () => {
    const created = await jobRepo.create({ sourceId: 'D-1', correlationId: 'c-1', payload: null, dedupeKey: null, status: JOB_STATUS.PENDING, attempts: 0, maxAttempts: 8 })
    const res = await uc.execute({ job: created })
    expect(res.job.status).toBe(JOB_STATUS.COMPLETED)
    expect(res.result.targetId).toBe('stub-1')
    expect(mappingRepo._all()).toHaveLength(1)
    expect(audit._all().map((e) => e.event)).toEqual(
      expect.arrayContaining([
        'job.processing.start', 'source.fetched', 'source.references.resolved',
        'validators.passed', 'target.upserted', 'mapping.upserted',
        'source.writeback.done', 'job.completed'
      ])
    )
  })

  it('stores salesOrderId in mapping metadata when upsert returns it', async () => {
    const gwWithSo = fakeTargetGateway({ upsert: async () => ({ targetId: 'MO-1', targetRef: null, syncToken: 'draft', salesOrderId: 'SO-1' }) })
    const u = new ProcessSyncJobUseCase({
      jobRepository: jobRepo, mappingRepository: mappingRepo,
      sourceGateway: sourceGw, targetGateway: gwWithSo,
      auditTrail: audit, validators: [], retryPolicy: { jitter: false, buildWriteBackPayload: (m) => ({ ref: m.targetRef }) }
    })
    const created = await jobRepo.create({ sourceId: 'D-9', payload: null, dedupeKey: null, status: JOB_STATUS.PENDING, attempts: 0, maxAttempts: 8 })
    await u.execute({ job: created })
    const map = mappingRepo._all()[0]
    expect(map.targetId).toBe('MO-1')
    expect(map.metadata.salesOrderId).toBe('SO-1')
  })

  it('merges upsertResult.metadata into mapping.metadata', async () => {
    const gwWithMeta = fakeTargetGateway({
      upsert: async () => ({
        targetId: 'SO-1', targetRef: 'S06613', syncToken: 'draft',
        salesOrderId: 'SO-1',
        metadata: { countryExpense: { status: 'resolved', id: 78, countryId: 49, countryName: 'Colombia', reason: 'ddp_exact_match', matches: 1, ambiguous: false } }
      })
    })
    const u = new ProcessSyncJobUseCase({
      jobRepository: jobRepo, mappingRepository: mappingRepo,
      sourceGateway: sourceGw, targetGateway: gwWithMeta,
      auditTrail: audit, validators: [], retryPolicy: { jitter: false, buildWriteBackPayload: (m) => ({ ref: m.targetRef }) }
    })
    const created = await jobRepo.create({ sourceId: 'D-10', payload: null, dedupeKey: null, status: JOB_STATUS.PENDING, attempts: 0, maxAttempts: 8 })
    await u.execute({ job: created })
    const map = mappingRepo._all()[0]
    expect(map.metadata.countryExpense).toEqual({
      status: 'resolved', id: 78, countryId: 49, countryName: 'Colombia',
      reason: 'ddp_exact_match', matches: 1, ambiguous: false
    })
    expect(map.metadata.salesOrderId).toBe('SO-1')
    expect(map.metadata.lastJobId).toBe(created._id)
  })

  it('includes metadata in the target.upserted audit detail', async () => {
    const gwWithMeta = fakeTargetGateway({
      upsert: async () => ({
        targetId: 'SO-1', targetRef: 'S06613', syncToken: 'draft', salesOrderId: 'SO-1',
        metadata: { countryExpense: { status: 'unresolved', reason: 'partner_has_no_country' } }
      })
    })
    const u = new ProcessSyncJobUseCase({
      jobRepository: jobRepo, mappingRepository: mappingRepo,
      sourceGateway: sourceGw, targetGateway: gwWithMeta,
      auditTrail: audit, validators: [], retryPolicy: { jitter: false, buildWriteBackPayload: (m) => ({ ref: m.targetRef }) }
    })
    const created = await jobRepo.create({ sourceId: 'D-11', payload: null, dedupeKey: null, status: JOB_STATUS.PENDING, attempts: 0, maxAttempts: 8 })
    await u.execute({ job: created })
    const upserted = audit._all().find((a) => a.event === 'target.upserted')
    expect(upserted.detail.targetId).toBe('SO-1')
    expect(upserted.detail.targetRef).toBe('S06613')
    expect(upserted.detail.salesOrderId).toBe('SO-1')
    expect(upserted.detail.metadata).toEqual({ countryExpense: { status: 'unresolved', reason: 'partner_has_no_country' } })
  })

  it('SkipSyncError -> SKIPPED with no retry', async () => {
    const v = () => { throw new SkipSyncError('no line items') }
    const u = new ProcessSyncJobUseCase({
      jobRepository: jobRepo, mappingRepository: mappingRepo,
      sourceGateway: sourceGw, targetGateway: targetGw,
      auditTrail: audit, validators: [v], retryPolicy: { jitter: false, buildWriteBackPayload: (m) => ({ ref: m.targetRef }) }
    })
    const created = await jobRepo.create({ sourceId: 'D-2', payload: null, dedupeKey: null, status: JOB_STATUS.PENDING, attempts: 0, maxAttempts: 8 })
    const res = await u.execute({ job: created })
    expect(res.skipped).toBe(true)
    expect(res.job.status).toBe(JOB_STATUS.SKIPPED)
    expect(res.job.lastError).toBe('no line items')
  })

  it('job.skipped audit carries err.detail as skipDetail so the reason is diagnosable', async () => {
    const detail = { code: 'ODOO_PRODUCT_NOT_FOUND', unresolved: [{ lineItemId: 'L-1', reason: 'not_found' }] }
    const v = () => { throw new SkipSyncError('producto no resuelto', { detail }) }
    const u = new ProcessSyncJobUseCase({
      jobRepository: jobRepo, mappingRepository: mappingRepo,
      sourceGateway: sourceGw, targetGateway: targetGw,
      auditTrail: audit, validators: [v], retryPolicy: { jitter: false, buildWriteBackPayload: (m) => ({ ref: m.targetRef }) }
    })
    const created = await jobRepo.create({ sourceId: 'D-3', payload: null, dedupeKey: null, status: JOB_STATUS.PENDING, attempts: 0, maxAttempts: 8 })
    await u.execute({ job: created })
    const skipped = audit._all().find((a) => a.event === 'job.skipped')
    expect(skipped.detail.reason).toBe('producto no resuelto')
    expect(skipped.detail.skipDetail).toEqual(detail)
  })

  it('job.skipped audit sets skipDetail to null when the error has no detail', async () => {
    const v = () => { throw new SkipSyncError('sin detalle') }
    const u = new ProcessSyncJobUseCase({
      jobRepository: jobRepo, mappingRepository: mappingRepo,
      sourceGateway: sourceGw, targetGateway: targetGw,
      auditTrail: audit, validators: [v], retryPolicy: { jitter: false, buildWriteBackPayload: (m) => ({ ref: m.targetRef }) }
    })
    const created = await jobRepo.create({ sourceId: 'D-4', payload: null, dedupeKey: null, status: JOB_STATUS.PENDING, attempts: 0, maxAttempts: 8 })
    await u.execute({ job: created })
    const skipped = audit._all().find((a) => a.event === 'job.skipped')
    expect(skipped.detail.skipDetail).toBeNull()
  })

  it('retryable error -> RETRY_PENDING with nextRetryAt', async () => {
    const target = {
      async upsert() {
        const e = new Error('upstream 503')
        e.httpStatus = 503
        throw e
      }
    }
    const u = new ProcessSyncJobUseCase({
      jobRepository: jobRepo, mappingRepository: mappingRepo,
      sourceGateway: sourceGw, targetGateway: target,
      auditTrail: audit, validators: [], retryPolicy: { jitter: false, baseMs: 1000, buildWriteBackPayload: (m) => ({ ref: m.targetRef }) }
    })
    const created = await jobRepo.create({ sourceId: 'D-3', payload: null, dedupeKey: null, status: JOB_STATUS.PENDING, attempts: 0, maxAttempts: 8 })
    const res = await u.execute({ job: created })
    expect(res.deadLetter).toBe(false)
    expect(res.job.status).toBe(JOB_STATUS.RETRY_PENDING)
    expect(res.job.nextRetryAt).toBeInstanceOf(Date)
  })

  it('dead letter when attempts >= maxAttempts', async () => {
    const target = {
      async upsert() {
        const e = new Error('upstream 503'); e.httpStatus = 503; throw e
      }
    }
    const u = new ProcessSyncJobUseCase({
      jobRepository: jobRepo, mappingRepository: mappingRepo,
      sourceGateway: sourceGw, targetGateway: target,
      auditTrail: audit, validators: [], retryPolicy: { jitter: false, baseMs: 1000, buildWriteBackPayload: (m) => ({ ref: m.targetRef }) }
    })
    const created = await jobRepo.create({ sourceId: 'D-4', payload: null, dedupeKey: null, status: JOB_STATUS.PENDING, attempts: 8, maxAttempts: 8 })
    const res = await u.execute({ job: created })
    expect(res.deadLetter).toBe(true)
    expect(res.job.status).toBe(JOB_STATUS.DEAD_LETTER)
    expect(res.job.nextRetryAt).toBeNull()
  })

  it('non-retryable error -> DEAD_LETTER', async () => {
    const target = {
      async upsert() {
        const e = new Error('bad request'); e.httpStatus = 400; throw e
      }
    }
    const u = new ProcessSyncJobUseCase({
      jobRepository: jobRepo, mappingRepository: mappingRepo,
      sourceGateway: sourceGw, targetGateway: target,
      auditTrail: audit, validators: [], retryPolicy: { jitter: false, baseMs: 1000, buildWriteBackPayload: (m) => ({ ref: m.targetRef }) }
    })
    const created = await jobRepo.create({ sourceId: 'D-5', payload: null, dedupeKey: null, status: JOB_STATUS.PENDING, attempts: 0, maxAttempts: 8 })
    const res = await u.execute({ job: created })
    expect(res.deadLetter).toBe(true)
    expect(res.job.status).toBe(JOB_STATUS.DEAD_LETTER)
  })

  it('missing odooCustomerId from references + transient error -> RETRY_PENDING', async () => {
    const sourceNoRefs = {
      async fetchRecord(sid) { return { id: sid, properties: {} } },
      async resolveReferences() { return {} },
      async writeBack() {}
    }
    const target = {
      async upsert() {
        const e = new Error('missing odoo customer'); e.transient = true; throw e
      }
    }
    const u = new ProcessSyncJobUseCase({
      jobRepository: jobRepo, mappingRepository: mappingRepo,
      sourceGateway: sourceNoRefs, targetGateway: target,
      auditTrail: audit, validators: [], retryPolicy: { jitter: false, baseMs: 1000, buildWriteBackPayload: (m) => ({ ref: m.targetRef }) }
    })
    const created = await jobRepo.create({ sourceId: 'D-6', payload: null, dedupeKey: null, status: JOB_STATUS.PENDING, attempts: 0, maxAttempts: 8 })
    const res = await u.execute({ job: created })
    expect(res.deadLetter).toBe(false)
    expect(res.job.status).toBe(JOB_STATUS.RETRY_PENDING)
  })
})
