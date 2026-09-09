import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { TriggerQuoteReleaseUseCase } = require('../../../src/core/application/use-cases/TriggerQuoteReleaseUseCase.js')

function makeEvaluateQuoteRelease({ canRelease = false, tracker = null } = {}) {
  return { execute: vi.fn(async () => ({ tracker, canRelease })) }
}

function makeEnqueueSyncJobUseCase({ result = { job: { _id: 'JOB-1' }, deduped: false } } = {}) {
  return { execute: vi.fn(async () => result) }
}

function makeTrackerRepository() {
  return { save: vi.fn(async (tracker) => tracker) }
}

describe('TriggerQuoteReleaseUseCase', () => {
  it('requires evaluateQuoteRelease', () => {
    expect(() => new TriggerQuoteReleaseUseCase({
      enqueueSyncJobUseCase: makeEnqueueSyncJobUseCase(),
      trackerRepository: makeTrackerRepository()
    })).toThrow('evaluateQuoteRelease')
  })

  it('requires enqueueSyncJobUseCase', () => {
    expect(() => new TriggerQuoteReleaseUseCase({
      evaluateQuoteRelease: makeEvaluateQuoteRelease(),
      trackerRepository: makeTrackerRepository()
    })).toThrow('enqueueSyncJobUseCase')
  })

  it('requires trackerRepository', () => {
    expect(() => new TriggerQuoteReleaseUseCase({
      evaluateQuoteRelease: makeEvaluateQuoteRelease(),
      enqueueSyncJobUseCase: makeEnqueueSyncJobUseCase()
    })).toThrow('trackerRepository')
  })

  it('requires dealId and quoteId', async () => {
    const useCase = new TriggerQuoteReleaseUseCase({
      evaluateQuoteRelease: makeEvaluateQuoteRelease(),
      enqueueSyncJobUseCase: makeEnqueueSyncJobUseCase(),
      trackerRepository: makeTrackerRepository()
    })
    await expect(useCase.execute({ quoteId: 'quote-1' })).rejects.toThrow('dealId')
    await expect(useCase.execute({ dealId: 'deal-1' })).rejects.toThrow('quoteId')
  })

  it('does not enqueue anything or persist the tracker when the quote cannot be released', async () => {
    const tracker = { stage: 'released', release: vi.fn() }
    const evaluateQuoteRelease = makeEvaluateQuoteRelease({ canRelease: false, tracker })
    const enqueueSyncJobUseCase = makeEnqueueSyncJobUseCase()
    const trackerRepository = makeTrackerRepository()
    const useCase = new TriggerQuoteReleaseUseCase({ evaluateQuoteRelease, enqueueSyncJobUseCase, trackerRepository })

    const result = await useCase.execute({ dealId: 'deal-1', quoteId: 'quote-1' })

    expect(result).toEqual({ released: false, tracker, enqueued: null })
    expect(enqueueSyncJobUseCase.execute).not.toHaveBeenCalled()
    expect(trackerRepository.save).not.toHaveBeenCalled()
  })

  it('enqueues a quote sync job using the existing dealId:qQuoteId sourceId convention when released', async () => {
    const tracker = { stage: 'pending', release: vi.fn() }
    const evaluateQuoteRelease = makeEvaluateQuoteRelease({ canRelease: true, tracker })
    const enqueueResult = { job: { _id: 'JOB-9' }, deduped: false }
    const enqueueSyncJobUseCase = makeEnqueueSyncJobUseCase({ result: enqueueResult })
    const trackerRepository = makeTrackerRepository()
    const useCase = new TriggerQuoteReleaseUseCase({ evaluateQuoteRelease, enqueueSyncJobUseCase, trackerRepository })

    const result = await useCase.execute({
      dealId: 'deal-1',
      quoteId: 'quote-1',
      correlationId: 'corr-1',
      rawPayload: { foo: 'bar' }
    })

    expect(enqueueSyncJobUseCase.execute).toHaveBeenCalledWith({
      sourceId: 'deal-1:qquote-1',
      correlationId: 'corr-1',
      rawPayload: expect.objectContaining({ foo: 'bar', releasedAt: expect.any(String), shouldConfirm: true }),
      kind: 'quote'
    })
    expect(result).toEqual({ released: true, tracker, enqueued: enqueueResult })
  })

  it('stamps a per-attempt releasedAt onto rawPayload so the dedupeKey varies on every release (never a silent duplicate)', async () => {
    const tracker = { stage: 'pending', release: vi.fn() }
    const evaluateQuoteRelease = makeEvaluateQuoteRelease({ canRelease: true, tracker })
    const enqueueSyncJobUseCase = makeEnqueueSyncJobUseCase()
    const trackerRepository = makeTrackerRepository()
    const timestamps = ['2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z']
    const clock = vi.fn(() => new Date(timestamps.shift()))
    const useCase = new TriggerQuoteReleaseUseCase({ evaluateQuoteRelease, enqueueSyncJobUseCase, trackerRepository, clock })

    await useCase.execute({ dealId: 'deal-1', quoteId: 'quote-1' })
    await useCase.execute({ dealId: 'deal-1', quoteId: 'quote-1' })

    const [firstCall, secondCall] = enqueueSyncJobUseCase.execute.mock.calls
    expect(firstCall[0].rawPayload).not.toEqual(secondCall[0].rawPayload)
    expect(firstCall[0].rawPayload.releasedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(secondCall[0].rawPayload.releasedAt).toBe('2026-01-01T00:05:00.000Z')
  })

  it('releases and persists the tracker when the quote is released', async () => {
    const tracker = { stage: 'pending', release: vi.fn() }
    const evaluateQuoteRelease = makeEvaluateQuoteRelease({ canRelease: true, tracker })
    const enqueueSyncJobUseCase = makeEnqueueSyncJobUseCase()
    const trackerRepository = makeTrackerRepository()
    const useCase = new TriggerQuoteReleaseUseCase({ evaluateQuoteRelease, enqueueSyncJobUseCase, trackerRepository })

    await useCase.execute({ dealId: 'deal-1', quoteId: 'quote-1' })

    expect(tracker.release).toHaveBeenCalledTimes(1)
    expect(trackerRepository.save).toHaveBeenCalledWith(tracker)
  })

  it('persists the released tracker BEFORE enqueueing, so a poller that claims the job immediately never reads a stale tracker', async () => {
    const order = [];
    const tracker = { stage: 'cancelled', release: vi.fn(() => { order.push('release') }) };
    const evaluateQuoteRelease = makeEvaluateQuoteRelease({ canRelease: true, tracker });
    const enqueueSyncJobUseCase = { execute: vi.fn(async () => { order.push('enqueue'); return { job: { _id: 'JOB-1' }, deduped: false } }) };
    const trackerRepository = { save: vi.fn(async (t) => { order.push('save'); return t }) };
    const useCase = new TriggerQuoteReleaseUseCase({ evaluateQuoteRelease, enqueueSyncJobUseCase, trackerRepository });

    await useCase.execute({ dealId: 'deal-1', quoteId: 'quote-1' });

    expect(order).toEqual(['release', 'save', 'enqueue']);
  })

  it('passes dealId and quoteId through to evaluateQuoteRelease (so a first-ever click on an untracked quote can find-or-create)', async () => {
    const evaluateQuoteRelease = makeEvaluateQuoteRelease({ canRelease: false })
    const enqueueSyncJobUseCase = makeEnqueueSyncJobUseCase()
    const trackerRepository = makeTrackerRepository()
    const useCase = new TriggerQuoteReleaseUseCase({ evaluateQuoteRelease, enqueueSyncJobUseCase, trackerRepository })

    await useCase.execute({ dealId: 'deal-1', quoteId: 'quote-1' })

    expect(evaluateQuoteRelease.execute).toHaveBeenCalledWith({ quoteId: 'quote-1', dealId: 'deal-1' })
  })
})
