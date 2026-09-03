import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { EvaluateQuoteReleaseUseCase } = require('../../../src/core/application/use-cases/EvaluateQuoteReleaseUseCase.js')
const { QUOTE_RELEASE_STAGE, QuoteReleaseTracker } = require('../../../src/core/domain/QuoteReleaseTracker.js')

function makeTrackerRepository({ tracker = null } = {}) {
  return {
    findByQuoteId: vi.fn(async () => tracker),
    save: vi.fn(async (t) => t)
  }
}

describe('EvaluateQuoteReleaseUseCase', () => {
  it('requires trackerRepository', () => {
    expect(() => new EvaluateQuoteReleaseUseCase({})).toThrow('trackerRepository')
  })

  it('requires quoteId', async () => {
    const useCase = new EvaluateQuoteReleaseUseCase({ trackerRepository: makeTrackerRepository() })
    await expect(useCase.execute({})).rejects.toThrow('quoteId')
  })

  it('returns canRelease=false and a null tracker when no tracker exists for the quote and no dealId is given', async () => {
    const trackerRepository = makeTrackerRepository({ tracker: null })
    const useCase = new EvaluateQuoteReleaseUseCase({ trackerRepository })
    const result = await useCase.execute({ quoteId: 'quote-1' })
    expect(result).toEqual({ tracker: null, canRelease: false })
    expect(trackerRepository.findByQuoteId).toHaveBeenCalledWith('quote-1')
    expect(trackerRepository.save).not.toHaveBeenCalled()
  })

  it('logs a warning when no tracker exists and no dealId is given', async () => {
    const trackerRepository = makeTrackerRepository({ tracker: null })
    const logger = { warn: vi.fn() }
    const useCase = new EvaluateQuoteReleaseUseCase({ trackerRepository, logger })
    await useCase.execute({ quoteId: 'quote-1' })
    expect(logger.warn).toHaveBeenCalledWith('EvaluateQuoteReleaseUseCase: no tracker found for quote', { quoteId: 'quote-1' })
  })

  it('creates and persists a fresh PENDING tracker when none exists and dealId is given, reporting canRelease=true', async () => {
    const trackerRepository = makeTrackerRepository({ tracker: null })
    const useCase = new EvaluateQuoteReleaseUseCase({ trackerRepository })
    const result = await useCase.execute({ quoteId: 'quote-1', dealId: 'deal-1' })
    expect(trackerRepository.save).toHaveBeenCalledTimes(1)
    const saved = trackerRepository.save.mock.calls[0][0]
    expect(saved).toBeInstanceOf(QuoteReleaseTracker)
    expect(saved.quoteId).toBe('quote-1')
    expect(saved.dealId).toBe('deal-1')
    expect(saved.stage).toBe(QUOTE_RELEASE_STAGE.PENDING)
    expect(result.tracker).toBe(saved)
    expect(result.canRelease).toBe(true)
  })

  it('returns canRelease=true when the tracker is pending', async () => {
    const tracker = new QuoteReleaseTracker({ quoteId: 'quote-1', dealId: 'deal-1' })
    const trackerRepository = makeTrackerRepository({ tracker })
    const useCase = new EvaluateQuoteReleaseUseCase({ trackerRepository })
    const result = await useCase.execute({ quoteId: 'quote-1' })
    expect(result).toEqual({ tracker, canRelease: true })
  })

  it('returns canRelease=false when the tracker is already released', async () => {
    const tracker = new QuoteReleaseTracker({ quoteId: 'quote-1', dealId: 'deal-1', stage: QUOTE_RELEASE_STAGE.RELEASED })
    const trackerRepository = makeTrackerRepository({ tracker })
    const useCase = new EvaluateQuoteReleaseUseCase({ trackerRepository })
    const result = await useCase.execute({ quoteId: 'quote-1' })
    expect(result).toEqual({ tracker, canRelease: false })
  })

  it('returns canRelease=false when the tracker is cancelled', async () => {
    const tracker = new QuoteReleaseTracker({ quoteId: 'quote-1', dealId: 'deal-1', stage: QUOTE_RELEASE_STAGE.CANCELLED })
    const trackerRepository = makeTrackerRepository({ tracker })
    const useCase = new EvaluateQuoteReleaseUseCase({ trackerRepository })
    const result = await useCase.execute({ quoteId: 'quote-1' })
    expect(result).toEqual({ tracker, canRelease: false })
  })
})
