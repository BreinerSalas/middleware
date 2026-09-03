import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  QUOTE_RELEASE_STAGE,
  QuoteReleaseTracker
} = require('../../../src/core/domain/QuoteReleaseTracker.js')

describe('QuoteReleaseTracker (domain)', () => {
  describe('construction', () => {
    it('requires a quoteId', () => {
      expect(() => new QuoteReleaseTracker({ dealId: 'deal-1' })).toThrow('quoteId')
    })

    it('requires a dealId', () => {
      expect(() => new QuoteReleaseTracker({ quoteId: 'quote-1' })).toThrow('dealId')
    })

    it('defaults to the pending stage', () => {
      const tracker = new QuoteReleaseTracker({ quoteId: 'quote-1', dealId: 'deal-1' })
      expect(tracker.stage).toBe(QUOTE_RELEASE_STAGE.PENDING)
    })

    it('rejects an unknown stage', () => {
      expect(() => new QuoteReleaseTracker({ quoteId: 'quote-1', dealId: 'deal-1', stage: 'cerrado' }))
        .toThrow('unknown stage')
    })

    it('accepts an explicit valid stage', () => {
      const tracker = new QuoteReleaseTracker({
        quoteId: 'quote-1',
        dealId: 'deal-1',
        stage: QUOTE_RELEASE_STAGE.RELEASED
      })
      expect(tracker.stage).toBe(QUOTE_RELEASE_STAGE.RELEASED)
    })
  })

  describe('release / cancel', () => {
    it('moves the stage to released', () => {
      const tracker = new QuoteReleaseTracker({ quoteId: 'quote-1', dealId: 'deal-1' })
      tracker.release()
      expect(tracker.stage).toBe(QUOTE_RELEASE_STAGE.RELEASED)
    })

    it('moves a pending tracker to cancelled', () => {
      const tracker = new QuoteReleaseTracker({ quoteId: 'quote-1', dealId: 'deal-1' })
      tracker.cancel()
      expect(tracker.stage).toBe(QUOTE_RELEASE_STAGE.CANCELLED)
    })

    it('moves a released tracker to cancelled, e.g. after a downstream MO cancellation', () => {
      const tracker = new QuoteReleaseTracker({
        quoteId: 'quote-1',
        dealId: 'deal-1',
        stage: QUOTE_RELEASE_STAGE.RELEASED
      })
      tracker.cancel()
      expect(tracker.stage).toBe(QUOTE_RELEASE_STAGE.CANCELLED)
    })
  })

  describe('canRelease', () => {
    it('returns true when the stage is pending', () => {
      const tracker = new QuoteReleaseTracker({ quoteId: 'quote-1', dealId: 'deal-1' })
      expect(tracker.canRelease()).toBe(true)
    })

    it('returns false when the stage is released', () => {
      const tracker = new QuoteReleaseTracker({
        quoteId: 'quote-1',
        dealId: 'deal-1',
        stage: QUOTE_RELEASE_STAGE.RELEASED
      })
      expect(tracker.canRelease()).toBe(false)
    })

    it('returns false when the stage is cancelled', () => {
      const tracker = new QuoteReleaseTracker({
        quoteId: 'quote-1',
        dealId: 'deal-1',
        stage: QUOTE_RELEASE_STAGE.CANCELLED
      })
      expect(tracker.canRelease()).toBe(false)
    })
  })
})
