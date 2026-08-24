import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { PlanDealSyncUseCase } = require('../../src/core/application/use-cases/PlanDealSyncUseCase.js')
const { JOB_STATUS } = require('../../src/core/domain/SyncJob.js')
const { mustHaveLineItems } = require('../../src/composition/validators.js')

const DEAL_JOB_BASE = {
  _id: 'J-DEAL-1',
  sourceId: 'D-1',
  correlationId: 'corr-1',
  payload: { rawBody: 'raw-1', eventType: 'deal.propertyChange' },
  dedupeKey: 'deal-dedupe-1',
  status: JOB_STATUS.PENDING,
  attempts: 0,
  maxAttempts: 8
}

function makeDeps({
  eligibility = { eligible: [], skipped: [], currencies: [] },
  fetchResult = { id: 'D-1', properties: { dealstage: 'closedwon', pipeline: 'p1' } },
  enqueueResult = (sourceId) => ({ job: { _id: `J-${sourceId}`, sourceId }, deduped: false }),
  validators = [],
  markCompleted = null,
  markSkipped = null,
  audit = null
} = {}) {
  return {
    sourceGateway: {
      fetchRecord: vi.fn(async () => fetchResult),
      apiClient: { getDealQuotes: vi.fn(async () => []) }
    },
    listEligibleQuotes: vi.fn(async () => eligibility),
    enqueueSyncJobUseCase: {
      execute: vi.fn(async ({ sourceId }) => enqueueResult(sourceId))
    },
    jobRepository: {
      markCompleted: vi.fn(markCompleted || (async () => ({ ...DEAL_JOB_BASE, status: JOB_STATUS.COMPLETED }))),
      markSkipped: vi.fn(markSkipped || (async () => ({ ...DEAL_JOB_BASE, status: JOB_STATUS.SKIPPED })))
    },
    auditTrail: {
      record: vi.fn(audit || (async () => true))
    },
    validators
  }
}

describe('PlanDealSyncUseCase', () => {
  it('returns mode=fallback when the deal has no eligible quotes (without marking the job)', async () => {
    const deps = makeDeps({ eligibility: { eligible: [], skipped: [], currencies: [] } })
    const uc = new PlanDealSyncUseCase(deps)
    const result = await uc.execute({ job: DEAL_JOB_BASE })
    expect(result.mode).toBe('fallback')
    expect(deps.enqueueSyncJobUseCase.execute).not.toHaveBeenCalled()
    expect(deps.jobRepository.markCompleted).not.toHaveBeenCalled()
    expect(deps.auditTrail.record).toHaveBeenCalled() // validators.passed audit before partition
    const expandedAudit = deps.auditTrail.record.mock.calls.find((c) => c[0] && c[0].event === 'deal.expanded')
    expect(expandedAudit).toBeUndefined()
  })

  it('returns mode=skipped (not fallback) when the deal HAS quotes but none are currently eligible — falling back would silently guess country/incoterm/document-type and duplicate the Sale Order later once a quote becomes eligible (its origin differs from the fallback path\'s)', async () => {
    const eligibility = {
      eligible: [],
      skipped: [{ quoteId: 'Q-1', reason: 'missing_incoterm' }, { quoteId: 'Q-2', reason: 'missing_document_type' }],
      currencies: []
    }
    const deps = makeDeps({ eligibility })
    const uc = new PlanDealSyncUseCase(deps)
    const result = await uc.execute({ job: DEAL_JOB_BASE })
    expect(result.mode).toBe('skipped')
    expect(deps.jobRepository.markSkipped).toHaveBeenCalledWith('J-DEAL-1', expect.any(Error))
    expect(deps.enqueueSyncJobUseCase.execute).not.toHaveBeenCalled()
    const skipAudit = deps.auditTrail.record.mock.calls.find((c) => c[0] && c[0].event === 'job.skipped')
    expect(skipAudit).toBeTruthy()
  })

  it('returns mode=expanded and enqueues one job per eligible quote', async () => {
    const eligibility = {
      eligible: [
        { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'GT', hs_currency: 'GTQ' } },
        { id: 'Q-2', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'HN', hs_currency: 'HNL' } },
        { id: 'Q-3', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'CR', hs_currency: 'CRC' } }
      ],
      skipped: [],
      currencies: ['GTQ', 'HNL', 'CRC']
    }
    const deps = makeDeps({ eligibility })
    const uc = new PlanDealSyncUseCase(deps)
    const result = await uc.execute({ job: DEAL_JOB_BASE })
    expect(result.mode).toBe('expanded')
    expect(result.currencies).toEqual(['GTQ', 'HNL', 'CRC'])
    expect(deps.enqueueSyncJobUseCase.execute).toHaveBeenCalledTimes(3)
    expect(deps.enqueueSyncJobUseCase.execute.mock.calls.map((c) => c[0].sourceId))
      .toEqual(['D-1:qQ-1', 'D-1:qQ-2', 'D-1:qQ-3'])
  })

  it('child job sourceId is constructed as <dealId>:q<quoteId>', async () => {
    const eligibility = {
      eligible: [{ id: 'Q-9', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'GT' } }],
      skipped: [],
      currencies: []
    }
    const deps = makeDeps({ eligibility })
    const uc = new PlanDealSyncUseCase(deps)
    await uc.execute({ job: DEAL_JOB_BASE })
    expect(deps.enqueueSyncJobUseCase.execute.mock.calls[0][0].sourceId).toBe('D-1:qQ-9')
  })

  it('child rawPayload derives from the parent payload + the quoteId', async () => {
    const eligibility = {
      eligible: [{ id: 'Q-7', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'GT' } }],
      skipped: [],
      currencies: []
    }
    const deps = makeDeps({ eligibility })
    const uc = new PlanDealSyncUseCase(deps)
    await uc.execute({ job: DEAL_JOB_BASE })
    const call = deps.enqueueSyncJobUseCase.execute.mock.calls[0][0]
    expect(call.rawPayload).toEqual({
      rawBody: 'raw-1',
      eventType: 'deal.propertyChange',
      quoteId: 'Q-7'
    })
  })

  it('marks the parent job COMPLETED and writes deal.expanded audit', async () => {
    const audit = vi.fn(async () => true)
    const eligibility = {
      eligible: [{ id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'GT' } }],
      skipped: [{ quoteId: 'Q-2', reason: 'missing_country' }],
      currencies: ['GTQ']
    }
    const deps = makeDeps({ eligibility, audit })
    const uc = new PlanDealSyncUseCase(deps)
    const result = await uc.execute({ job: DEAL_JOB_BASE })
    expect(result.mode).toBe('expanded')
    expect(deps.jobRepository.markCompleted).toHaveBeenCalledWith('J-DEAL-1')
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'D-1',
      event: 'deal.expanded',
      success: true,
      detail: expect.objectContaining({
        eligibleCount: 1,
        skippedCount: 1,
        currencies: ['GTQ']
      })
    }))
  })

  it('warns but does not block when currencies differ across eligible quotes (decision E)', async () => {
    const logger = { warn: vi.fn(), info: vi.fn() }
    const eligibility = {
      eligible: [
        { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'GT', hs_currency: 'GTQ' } },
        { id: 'Q-2', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'HN', hs_currency: 'HNL' } }
      ],
      skipped: [],
      currencies: ['GTQ', 'HNL']
    }
    const deps = makeDeps({ eligibility })
    const uc = new PlanDealSyncUseCase({ ...deps, logger })
    const result = await uc.execute({ job: DEAL_JOB_BASE })
    expect(result.mode).toBe('expanded')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/mixed currencies/i), expect.objectContaining({ currencies: ['GTQ', 'HNL'] }))
  })

  it('does NOT apply mustHaveLineItems (the line items check belongs to the per-quote job)', async () => {
    const mustHaveLineItemsSpy = vi.fn((mustHaveLineItems.__spied = true, mustHaveLineItems))
    const eligibility = {
      eligible: [{ id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'GT' } }],
      skipped: [],
      currencies: []
    }
    const deps = makeDeps({ eligibility, validators: [mustHaveLineItems] })
    const uc = new PlanDealSyncUseCase(deps)
    const result = await uc.execute({ job: DEAL_JOB_BASE })
    expect(result.mode).toBe('expanded')
    // mustHaveLineItems was filtered out by identity; the throw inside never fires
    expect(mustHaveLineItemsSpy).not.toHaveBeenCalled()
  })

  it('runs the stage/pipeline validators early (avoids quote RPCs for inapplicable deals)', async () => {
    const stageValid = vi.fn(() => { throw new Error('stage fail') })
    const eligibility = {
      eligible: [{ id: 'Q-1', properties: {} }],
      skipped: [],
      currencies: []
    }
    const deps = makeDeps({ eligibility, validators: [stageValid] })
    const uc = new PlanDealSyncUseCase(deps)
    await expect(uc.execute({ job: DEAL_JOB_BASE })).rejects.toThrow('stage fail')
    expect(deps.listEligibleQuotes).not.toHaveBeenCalled()
    expect(deps.enqueueSyncJobUseCase.execute).not.toHaveBeenCalled()
  })
})
