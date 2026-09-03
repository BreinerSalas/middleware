import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { RevertQuoteReleaseOnCancellationUseCase } = require('../../../src/core/application/use-cases/RevertQuoteReleaseOnCancellationUseCase.js')
const { QUOTE_RELEASE_STAGE, QuoteReleaseTracker } = require('../../../src/core/domain/QuoteReleaseTracker.js')

function makeTrackerRepository({ tracker = null } = {}) {
  return {
    findByQuoteId: vi.fn(async () => tracker),
    save: vi.fn(async (t) => t)
  }
}

function makeAuditTrail() {
  return { record: vi.fn(async (entry) => entry) }
}

describe('RevertQuoteReleaseOnCancellationUseCase', () => {
  it('requires trackerRepository', () => {
    expect(() => new RevertQuoteReleaseOnCancellationUseCase({})).toThrow('trackerRepository')
  })

  it('requires quoteId', async () => {
    const useCase = new RevertQuoteReleaseOnCancellationUseCase({ trackerRepository: makeTrackerRepository() })
    await expect(useCase.execute({})).rejects.toThrow('quoteId')
  })

  it('throws when no tracker exists for the quote', async () => {
    const trackerRepository = makeTrackerRepository({ tracker: null })
    const useCase = new RevertQuoteReleaseOnCancellationUseCase({ trackerRepository })
    await expect(useCase.execute({ quoteId: 'quote-1' })).rejects.toThrow('quote-1')
  })

  it('cancels a released tracker and persists it', async () => {
    const tracker = new QuoteReleaseTracker({ quoteId: 'quote-1', dealId: 'deal-1', stage: QUOTE_RELEASE_STAGE.RELEASED })
    const trackerRepository = makeTrackerRepository({ tracker })
    const useCase = new RevertQuoteReleaseOnCancellationUseCase({ trackerRepository })
    const result = await useCase.execute({ quoteId: 'quote-1' })
    expect(result.stage).toBe(QUOTE_RELEASE_STAGE.CANCELLED)
    expect(trackerRepository.save).toHaveBeenCalledWith(tracker)
  })

  it('leaves other tickets untouched by only loading/saving the requested quoteId', async () => {
    const tracker = new QuoteReleaseTracker({ quoteId: 'quote-1', dealId: 'deal-1', stage: QUOTE_RELEASE_STAGE.RELEASED })
    const trackerRepository = makeTrackerRepository({ tracker })
    const useCase = new RevertQuoteReleaseOnCancellationUseCase({ trackerRepository })
    await useCase.execute({ quoteId: 'quote-1' })
    expect(trackerRepository.findByQuoteId).toHaveBeenCalledTimes(1)
    expect(trackerRepository.findByQuoteId).toHaveBeenCalledWith('quote-1')
  })

  it('records an audit entry with the reason when auditTrail is provided', async () => {
    const tracker = new QuoteReleaseTracker({ quoteId: 'quote-1', dealId: 'deal-1', stage: QUOTE_RELEASE_STAGE.RELEASED })
    const trackerRepository = makeTrackerRepository({ tracker })
    const auditTrail = makeAuditTrail()
    const useCase = new RevertQuoteReleaseOnCancellationUseCase({ trackerRepository, auditTrail })
    await useCase.execute({ quoteId: 'quote-1', reason: 'MO cancelled in Odoo' })
    expect(auditTrail.record).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'quote-1',
      event: 'quote_release.cancelled',
      success: true,
      detail: expect.objectContaining({ dealId: 'deal-1', reason: 'MO cancelled in Odoo' })
    }))
  })

  it('works without an auditTrail (optional dependency)', async () => {
    const tracker = new QuoteReleaseTracker({ quoteId: 'quote-1', dealId: 'deal-1', stage: QUOTE_RELEASE_STAGE.RELEASED })
    const trackerRepository = makeTrackerRepository({ tracker })
    const useCase = new RevertQuoteReleaseOnCancellationUseCase({ trackerRepository })
    await expect(useCase.execute({ quoteId: 'quote-1' })).resolves.toBeDefined()
  })
})
